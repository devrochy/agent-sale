import type { Logger } from "pino";
import { canonicalToMetaRecipient } from "../gateway/channels/meta/addresses.js";
import { resolveApprovedTemplate } from "../gateway/channels/meta/resolveApprovedTemplate.js";
import { sendTemplateMessage } from "../gateway/channels/meta/templates.js";
import { sendToConversation } from "../gateway/sendMessage.js";
import { formatearDatosTransferencia } from "../domains/commerce/datosTransferencia.js";
import { appendMessage } from "../orchestrator/memory.js";
import { withTransaction } from "../shared/db/index.js";
import { getTransferAccounts } from "../shared/db/settingsDirectory.js";
import { logger } from "../shared/observability/logger.js";

interface CandidateRow {
  order_id: string;
  conversation_id: string;
  connection_id: string | null;
  external_id: string;
  customer_full_name: string | null;
  public_order_number: string;
  total: string;
  reciente: boolean;
}

/**
 * Pedidos por transferencia, pendientes de pago, sin comprobante válido
 * todavía y sin recordatorio ya mandado (pedido explícito del usuario:
 * "recordar a un cliente que envíe el comprobante si aún no se ha
 * enviado o se ha verificado por el asistente como correcto"). Se excluye
 * cualquier pedido cuyo último comprobante ya esté `pendiente_revision`
 * (escalado a un admin — ver procesarComprobante.ts) o aprobado: ese
 * ciclo lo maneja el ticket o ya está resuelto, no este job.
 *
 * Mismos bordes de antigüedad que cazadorDeVentas.ts/reactivarCotizacionesFrias.ts
 * (3h-7 días), y el mismo `reciente` (mensaje inbound en las últimas 24h)
 * para decidir texto libre vs. plantilla.
 */
async function fetchCandidates(): Promise<CandidateRow[]> {
  return withTransaction(async (client) => {
    const result = await client.query<CandidateRow>(
      `SELECT o.id AS order_id, o.conversation_id, conv.connection_id, cu.external_id,
              cu.full_name AS customer_full_name, o.public_order_number, o.total,
              EXISTS (
                SELECT 1 FROM messages m
                 WHERE m.conversation_id = o.conversation_id
                   AND m.direction = 'inbound' AND m.sender_type = 'customer'
                   AND m.created_at >= now() - interval '24 hours'
              ) AS reciente
         FROM orders o
         JOIN customers cu ON cu.id = o.customer_id
         JOIN conversations conv ON conv.id = o.conversation_id
        WHERE o.payment_method = 'transferencia'
          AND o.payment_status = 'pendiente'
          AND o.status = 'abierto'
          AND o.comprobante_reminder_sent_at IS NULL
          AND o.created_at <= now() - interval '3 hours'
          AND o.created_at >= now() - interval '7 days'
          AND (
            SELECT pr.resultado FROM payment_receipts pr
             WHERE pr.order_id = o.id
             ORDER BY pr.created_at DESC LIMIT 1
          ) IS DISTINCT FROM 'pendiente_revision'`,
    );
    return result.rows;
  });
}

async function markReminderSent(orderId: string): Promise<void> {
  await withTransaction((client) =>
    client.query(`UPDATE orders SET comprobante_reminder_sent_at = now() WHERE id = $1`, [orderId]),
  );
}

async function processCandidateReciente(candidate: CandidateRow, jobLogger: Logger): Promise<void> {
  const cuentas = (await getTransferAccounts()).filter((account) => account.active);
  if (cuentas.length === 0) {
    // Mismo criterio que enviarDatosTransferencia.ts: sin cuentas activas
    // no hay nada que recordar — no es un error, se salta sin marcar.
    return;
  }
  const texto =
    `Todavía no nos llegó el comprobante de tu pedido ${candidate.public_order_number} 📄 ` +
    `Te reenviamos los datos por si los necesitás:\n\n` +
    formatearDatosTransferencia(cuentas, candidate.public_order_number, Number(candidate.total));

  try {
    await sendToConversation(candidate.conversation_id, texto);
  } catch (error) {
    jobLogger.warn({ error }, "No se pudo mandar el recordatorio de comprobante (texto libre)");
    return;
  }
  await markReminderSent(candidate.order_id);
  try {
    await appendMessage(candidate.conversation_id, "outbound", "agent", texto);
  } catch (error) {
    jobLogger.warn({ error }, "Recordatorio de comprobante enviado, pero no se pudo guardar en el historial");
  }
}

async function processCandidateFriaFueraDeVentana(candidate: CandidateRow, jobLogger: Logger): Promise<void> {
  const resuelta = await resolveApprovedTemplate(candidate.connection_id, "recordatorio_comprobante");
  if (!resuelta.ok) {
    // La plantilla puede no estar aprobada todavía — no es un error, el
    // pedido sigue candidato en la próxima corrida (no se marca).
    return;
  }

  const nombre = candidate.customer_full_name || "cliente";
  const monto = `$${Number(candidate.total).toLocaleString("es-CO")}`;

  try {
    await sendTemplateMessage(
      resuelta.connection.credentials,
      resuelta.connection.externalId,
      canonicalToMetaRecipient(candidate.external_id),
      "recordatorio_comprobante",
      resuelta.template.language,
      [
        {
          type: "body",
          parameters: [
            { type: "text", text: nombre },
            { type: "text", text: candidate.public_order_number },
            { type: "text", text: monto },
          ],
        },
      ],
    );
  } catch (error) {
    jobLogger.warn({ error }, "No se pudo mandar el recordatorio de comprobante (plantilla)");
    return;
  }

  await markReminderSent(candidate.order_id);
  try {
    await appendMessage(
      candidate.conversation_id,
      "outbound",
      "agent",
      `Todavía no nos llegó el comprobante de tu pedido ${candidate.public_order_number} por ${monto}.`,
    );
  } catch (error) {
    jobLogger.warn({ error }, "Recordatorio de comprobante enviado, pero no se pudo guardar en el historial");
  }
}

async function processCandidate(candidate: CandidateRow, jobLogger: Logger): Promise<void> {
  const candidateLogger = jobLogger.child({
    conversation_id: candidate.conversation_id,
    order_id: candidate.order_id,
  });
  if (candidate.reciente) {
    await processCandidateReciente(candidate, candidateLogger);
  } else {
    await processCandidateFriaFueraDeVentana(candidate, candidateLogger);
  }
}

/**
 * Recorre los pedidos candidatos (best-effort por pedido). Se llama desde
 * el cron (src/jobs/scheduler.ts, misma cadencia horaria que
 * cazadorDeVentas.ts/reactivarCotizacionesFrias.ts) y manualmente en QA.
 */
export async function runRecordarComprobantePendiente(): Promise<void> {
  const jobLogger = logger.child({ event: "jobs.recordar_comprobante_pendiente" });
  try {
    const candidates = await fetchCandidates();
    for (const candidate of candidates) {
      await processCandidate(candidate, jobLogger);
    }
  } catch (error) {
    jobLogger.warn({ error }, "No se pudo correr el recordatorio de comprobante pendiente");
  }
}
