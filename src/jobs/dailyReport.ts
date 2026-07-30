import type { Logger } from "pino";
import { getWhatsAppMessageStatus, sendWhatsAppMessage } from "../gateway/sendMessage.js";
import { getReportRecipient, getTenant, listTenants, withTenant } from "../shared/db/index.js";
import { logger } from "../shared/observability/logger.js";

// WhatsApp resuelve entrega/rechazo en segundos, no minutos (confirmado en
// QA real: date_updated ~2s después de date_created en un mensaje
// rechazado por estar fuera de la ventana de 24h) — este delay alcanza
// para detectar el caso más común de fallo silencioso sin frenar el job
// mucho tiempo. Es un job diario con pocos tenants, no un path sensible a
// latencia.
const DELIVERY_CHECK_DELAY_MS = 4000;

interface DailyReportRow {
  mensajes: string;
  clientes_unicos: string;
  conversaciones_cerradas: string;
  escaladas: string;
  pedidos_confirmados: string;
  monto_total: string;
}

/**
 * "Ayer" en calendario de Bogotá (Colombia no tiene horario de verano, pero
 * se calcula con `AT TIME ZONE` igual que `formatFecha` en adminPanel.ts en
 * vez de restar un offset fijo a mano, para no depender de esa asunción si
 * el proyecto alguna vez sirve a un tenant en otro huso horario).
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
async function buildDailyReportRow(tenantId: string): Promise<DailyReportRow> {
  return withTenant(tenantId, async (client) => {
    const result = await client.query<DailyReportRow>(
      `WITH bounds AS (
         SELECT
           (date_trunc('day', now() AT TIME ZONE 'America/Bogota') - interval '1 day') AT TIME ZONE 'America/Bogota' AS desde,
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
    );
    return result.rows[0]!;
  });
}

function formatReportText(brand: string, row: DailyReportRow): string {
  const fecha = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    dateStyle: "long",
  }).format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const resueltasSinEscalar = Number(row.conversaciones_cerradas) - Number(row.escaladas);
  const monto = Number(row.monto_total).toLocaleString("es-CO");
  return (
    `📊 Reporte diario — ${brand}\n${fecha}\n\n` +
    `💬 Mensajes: ${row.mensajes}\n` +
    `👥 Clientes únicos: ${row.clientes_unicos}\n` +
    `✅ Conversaciones cerradas: ${row.conversaciones_cerradas} (${resueltasSinEscalar} sin escalar)\n` +
    `🛒 Pedidos confirmados: ${row.pedidos_confirmados} — $${monto}`
  );
}

/** `null` si el tenant no configuró `report_recipient_phone` (ver migrations/0024) o no existe — no es un error, ese tenant simplemente no recibe reporte. */
export async function buildDailyReportText(tenantId: string): Promise<string | null> {
  const [recipient, tenant] = await Promise.all([
    getReportRecipient(tenantId),
    getTenant(tenantId),
  ]);
  if (!recipient || !tenant) {
    return null;
  }
  const row = await buildDailyReportRow(tenantId);
  return formatReportText(tenant.display_name ?? tenant.name, row);
}

/**
 * Itera todos los tenants y manda el Reporte diario a quien lo tenga
 * configurado — un tenant que falla (sin destinatario, error de query, o
 * error de envío por WhatsApp) no debe frenar el reporte de los demás,
 * mismo criterio best-effort que `escalarHumano.ts` para notificaciones
 * proactivas. Se llama tanto desde el cron (src/jobs/scheduler.ts) como
 * manualmente en QA, sin depender de horario.
 */
export async function sendDailyReports(): Promise<void> {
  const tenants = await listTenants();
  for (const tenant of tenants) {
    const jobLogger = logger.child({ tenant_id: tenant.id, event: "jobs.reporte_diario" });
    try {
      const recipient = await getReportRecipient(tenant.id);
      if (!recipient) {
        continue;
      }
      const text = await buildDailyReportText(tenant.id);
      if (!text) {
        continue;
      }
      const sid = await sendWhatsAppMessage(recipient, text);
      await verifyDelivery(sid, jobLogger);
    } catch (error) {
      jobLogger.warn({ error }, "No se pudo enviar el reporte diario de este tenant");
    }
  }
}

/**
 * Confirma la entrega real del reporte ya enviado (ver sendWhatsAppMessage
 * — que no lance solo significa que Twilio lo aceptó, no que llegó). Un
 * fallo acá (no poder consultar el estado) no es lo mismo que un fallo de
 * envío: el mensaje sí se mandó, solo no se pudo verificar — se loguea
 * distinto para no confundir ambos casos en Loki/Grafana.
 */
async function verifyDelivery(sid: string, jobLogger: Logger): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, DELIVERY_CHECK_DELAY_MS));
  try {
    const { status, errorCode } = await getWhatsAppMessageStatus(sid);
    if (status === "undelivered" || status === "failed") {
      jobLogger.warn(
        { sid, status, errorCode },
        "Reporte diario rechazado por WhatsApp — probablemente fuera de la ventana de 24h (errorCode 63016) o el destinatario nunca inició conversación con el bot",
      );
    } else {
      jobLogger.info({ sid, status }, "Reporte diario enviado");
    }
  } catch (error) {
    jobLogger.warn(
      { sid, error },
      "Reporte diario enviado, pero no se pudo confirmar el estado de entrega",
    );
  }
}
