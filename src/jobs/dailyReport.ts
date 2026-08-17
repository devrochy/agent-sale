import { resolveNotificationRecipients } from "../admin/auth/adminsDirectory.js";
import { sendWhatsAppMessage } from "../gateway/sendMessage.js";
import {
  getReportFrequencyDays,
  getReportLastSentAt,
  getReportRecipient,
  getSettings,
  markReportSent,
  withTransaction,
} from "../shared/db/index.js";
import { logger } from "../shared/observability/logger.js";
import { verifyDelivery } from "./verifyDelivery.js";

interface DailyReportRow {
  mensajes: string;
  clientes_unicos: string;
  conversaciones_cerradas: string;
  escaladas: string;
  pedidos_confirmados: string;
  monto_total: string;
}

/**
 * Ventana de `days` días terminando "hoy" en calendario de Bogotá (Colombia
 * no tiene horario de verano, pero se calcula con `AT TIME ZONE` igual que
 * `formatFecha` en adminPanel.ts en vez de restar un offset fijo a mano,
 * para no depender de esa asunción si el proyecto alguna vez necesita otro
 * huso horario). `days=1` (diario, el default histórico) da exactamente
 * "ayer" — `make_interval(days => $1)` generaliza eso a cualquier cantidad
 * de días sin tener que armar el literal `interval` a mano por
 * concatenación de string.
 *
 * El `AT TIME ZONE` final (no solo el primero) es obligatorio: `now() AT
 * TIME ZONE 'America/Bogota'` da un `timestamp` SIN zona horaria (hora de
 * pared en Bogotá) — si se compara tal cual contra columnas `timestamptz`
 * (`created_at`), Postgres lo reinterpreta con el timezone de la SESIÓN
 * (UTC acá), no con 'America/Bogota', desfasando el límite 5 horas. Aplicar
 * `AT TIME ZONE` una segunda vez sobre ese resultado hace la conversión
 * inversa (naive → timestamptz anclado a Bogotá), que es lo que hay que
 * comparar. Bug real encontrado en QA: coincidía por casualidad en un
 * entorno con TZ local -05:00, pero fallaba en la comparación SQL interna
 * — confirmado con `pg_typeof` (timestamp vs. timestamp with time zone).
 */
async function buildDailyReportRow(days: number): Promise<DailyReportRow> {
  return withTransaction(async (client) => {
    const result = await client.query<DailyReportRow>(
      `WITH bounds AS (
         SELECT
           (date_trunc('day', now() AT TIME ZONE 'America/Bogota') - make_interval(days => $1)) AT TIME ZONE 'America/Bogota' AS desde,
           date_trunc('day', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota' AS hasta
       ),
       msgs AS (
         SELECT count(*) AS mensajes, count(DISTINCT conv.customer_id) AS clientes_unicos
         FROM messages m
         JOIN conversations conv ON conv.id = m.conversation_id, bounds
         WHERE m.created_at >= bounds.desde AND m.created_at < bounds.hasta
       ),
       cierres AS (
         SELECT count(DISTINCT c.id) AS conversaciones_cerradas, count(DISTINCT h.conversation_id) AS escaladas
         FROM conversations c
         LEFT JOIN handoff_queue h ON h.conversation_id = c.id, bounds
         WHERE c.status = 'closed' AND c.closed_at >= bounds.desde AND c.closed_at < bounds.hasta
       ),
       pedidos AS (
         SELECT count(*) AS pedidos_confirmados, coalesce(sum(total), 0) AS monto_total
         FROM orders o, bounds
         WHERE o.created_at >= bounds.desde AND o.created_at < bounds.hasta
       )
       SELECT * FROM msgs, cierres, pedidos`,
      [days],
    );
    return result.rows[0]!;
  });
}

/** "Diario"/"Semanal"/"Mensual" para los 3 valores con nombre propio en la UI (ver renderConfiguracionPage) — cualquier otro número es "personalizado". */
function frequencyLabel(days: number): string {
  if (days === 1) return "Diario";
  if (days === 7) return "Semanal";
  if (days === 30) return "Mensual";
  return `Cada ${days} días`;
}

function formatReportText(brand: string, row: DailyReportRow, days: number): string {
  const fecha = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    dateStyle: "long",
  }).format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const resueltasSinEscalar = Number(row.conversaciones_cerradas) - Number(row.escaladas);
  const monto = Number(row.monto_total).toLocaleString("es-CO");
  return (
    `📊 Reporte del asistente — ${brand}\n${frequencyLabel(days)} · hasta ${fecha}\n\n` +
    `💬 Mensajes: ${row.mensajes}\n` +
    `👥 Clientes únicos: ${row.clientes_unicos}\n` +
    `✅ Conversaciones cerradas: ${row.conversaciones_cerradas} (${resueltasSinEscalar} sin escalar)\n` +
    `🛒 Pedidos confirmados: ${row.pedidos_confirmados} — $${monto}`
  );
}

/**
 * `null` si no hay a quién mandárselo o todavía no se sembró `settings` —
 * no es un error, simplemente no se manda reporte. Destinatarios (Fase 13,
 * ver ADR-025): admins activos con `recibeReporteDiario` y teléfono
 * cargado; si no hay ninguno, cae a `report_recipient_phone` (ver
 * migrations/0024) por compatibilidad con instalaciones sin colaboradores
 * configurados todavía. La ventana de datos usa la frecuencia configurada
 * (`report_frequency_days`, Fase 13 v2) — esta función arma el texto para
 * lo que corresponda ahora mismo, independientemente de si "ya toca"
 * mandarlo (eso lo decide `sendDailyReports`, no acá — sirve también para
 * previsualizar en QA sin esperar la fecha).
 */
export async function buildDailyReportText(): Promise<string | null> {
  const settings = await getSettings();
  if (!settings) {
    return null;
  }
  const fallbackPhone = await getReportRecipient();
  const recipients = await resolveNotificationRecipients("recibeReporteDiario", fallbackPhone);
  if (recipients.length === 0) {
    return null;
  }
  const days = await getReportFrequencyDays();
  const row = await buildDailyReportRow(days);
  return formatReportText(settings.display_name ?? settings.name, row, days);
}

/**
 * Manda el Reporte del asistente a quien lo tenga configurado (uno o más
 * destinatarios, ver `buildDailyReportText`) cuando ya pasaron
 * `report_frequency_days` días desde el último envío (Fase 13 v2) — el
 * cron sigue corriendo una vez por día (scheduler.ts) sin importar la
 * frecuencia elegida, esta función es la que decide si "ya toca" comparando
 * contra `report_last_sent_at`. `null` (nunca se mandó) siempre toca. El
 * fallo de envío por WhatsApp de UN destinatario no debe frenar el de los
 * demás, mismo criterio best-effort que `escalarHumano.ts` para
 * notificaciones proactivas. Se llama tanto desde el cron como manualmente
 * en QA.
 */
export async function sendDailyReports(): Promise<void> {
  const jobLogger = logger.child({ event: "jobs.reporte_diario" });
  try {
    const fallbackPhone = await getReportRecipient();
    const recipients = await resolveNotificationRecipients("recibeReporteDiario", fallbackPhone);
    if (recipients.length === 0) {
      return;
    }
    const frequencyDays = await getReportFrequencyDays();
    const lastSentAt = await getReportLastSentAt();
    if (lastSentAt) {
      const dueAt = lastSentAt.getTime() + frequencyDays * 24 * 60 * 60 * 1000;
      if (Date.now() < dueAt) {
        return; // todavía no toca — el cron diario solo confirma, no fuerza el envío.
      }
    }
    const text = await buildDailyReportText();
    if (!text) {
      return;
    }
    let sentToAtLeastOne = false;
    for (const recipient of recipients) {
      try {
        const sid = await sendWhatsAppMessage(recipient, text);
        await verifyDelivery(sid, "Reporte del asistente", jobLogger);
        sentToAtLeastOne = true;
      } catch (error) {
        jobLogger.warn(
          { error, recipient },
          "No se pudo enviar el reporte del asistente a este destinatario — se sigue con el resto",
        );
      }
    }
    if (sentToAtLeastOne) {
      await markReportSent();
    }
  } catch (error) {
    jobLogger.warn({ error }, "No se pudo enviar el reporte del asistente");
  }
}
