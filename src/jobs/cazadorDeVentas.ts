import type { Logger } from "pino";
import { sendWhatsAppMessage } from "../gateway/sendMessage.js";
import { appendMessage } from "../orchestrator/memory.js";
import { withTransaction } from "../shared/db/index.js";
import { logger } from "../shared/observability/logger.js";
import { verifyDelivery } from "./verifyDelivery.js";

interface CandidateRow {
  quote_id: string;
  conversation_id: string;
  phone_number: string;
  total: string;
}

interface QuoteItemRow {
  name: string;
  quantity: number;
}

/**
 * Cotizaciones sin pedido confirmado, creadas hace entre 3 y 20 horas (ver
 * analisis-superpoderes.md, #3 Cazador de ventas) — fuera de esa ventana
 * el candidato sale solo del resultado, no hace falta lógica de
 * expiración aparte. El chequeo de la ventana de 24h de WhatsApp (ADR-019)
 * va en la misma query (EXISTS sobre el último mensaje inbound del
 * cliente) en vez de una consulta separada por cotización.
 */
async function fetchCandidates(): Promise<CandidateRow[]> {
  return withTransaction(async (client) => {
    const result = await client.query<CandidateRow>(
      `SELECT q.id AS quote_id, q.conversation_id, cu.phone_number, q.total
       FROM quotes q
       JOIN customers cu ON cu.id = q.customer_id
       WHERE q.follow_up_sent_at IS NULL
         AND q.created_at <= now() - interval '3 hours'
         AND q.created_at >= now() - interval '20 hours'
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.quote_id = q.id)
         AND EXISTS (
           SELECT 1 FROM messages m
           WHERE m.conversation_id = q.conversation_id
             AND m.direction = 'inbound' AND m.sender_type = 'customer'
             AND m.created_at >= now() - interval '24 hours'
         )`,
    );
    return result.rows;
  });
}

async function fetchQuoteItems(quoteId: string): Promise<QuoteItemRow[]> {
  return withTransaction(async (client) => {
    const result = await client.query<QuoteItemRow>(
      `SELECT p.name, qi.quantity
       FROM quote_items qi
       JOIN products p ON p.id = qi.product_id
       WHERE qi.quote_id = $1
       ORDER BY p.name`,
      [quoteId],
    );
    return result.rows;
  });
}

function formatFollowUpText(items: QuoteItemRow[], total: number): string {
  const itemsText = items
    .map((item) => (item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name))
    .join(", ");
  const monto = total.toLocaleString("es-CO");
  return (
    `¡Hola! 👋 Vi que estabas viendo ${itemsText} por un total de $${monto}.\n` +
    `¿Seguís interesado/a? Si tenés alguna duda o querés confirmar el pedido, contame y seguimos 😊`
  );
}

/**
 * Reengancha una cotización puntual — a partir de que `sendWhatsAppMessage`
 * no lanza, el mensaje YA se mandó, así que marcar `follow_up_sent_at` no
 * puede depender de los pasos siguientes (guardar en el historial,
 * verificar entrega): si esos fallaran y no marcáramos la cotización, la
 * próxima corrida le mandaría un segundo mensaje al mismo cliente.
 */
async function processCandidate(candidate: CandidateRow, jobLogger: Logger): Promise<void> {
  const candidateLogger = jobLogger.child({
    conversation_id: candidate.conversation_id,
    quote_id: candidate.quote_id,
  });

  let text: string;
  try {
    const items = await fetchQuoteItems(candidate.quote_id);
    text = formatFollowUpText(items, Number(candidate.total));
  } catch (error) {
    candidateLogger.warn(
      { error },
      "No se pudo armar el mensaje de reenganche para esta cotización",
    );
    return;
  }

  let sid: string;
  try {
    sid = await sendWhatsAppMessage(candidate.phone_number, text);
  } catch (error) {
    candidateLogger.warn(
      { error },
      "No se pudo enviar el mensaje de reenganche — se reintenta en la próxima corrida",
    );
    return;
  }

  try {
    await withTransaction((client) =>
      client.query("UPDATE quotes SET follow_up_sent_at = now() WHERE id = $1", [
        candidate.quote_id,
      ]),
    );
  } catch (error) {
    candidateLogger.warn(
      { error, sid },
      "Mensaje de reenganche enviado, pero no se pudo marcar follow_up_sent_at — podría reenviarse en la próxima corrida",
    );
  }

  try {
    await appendMessage(candidate.conversation_id, "outbound", "agent", text);
  } catch (error) {
    candidateLogger.warn(
      { error, sid },
      "Mensaje de reenganche enviado, pero no se pudo guardar en el historial de la conversación",
    );
  }

  await verifyDelivery(sid, "Mensaje de reenganche", candidateLogger);
}

/**
 * Recorre todas las cotizaciones candidatas (best-effort por cotización —
 * que una falle no debe frenar las demás). Se llama tanto desde el cron
 * (src/jobs/scheduler.ts, cada hora) como manualmente en QA.
 */
export async function runCazadorDeVentas(): Promise<void> {
  const jobLogger = logger.child({ event: "jobs.cazador_ventas" });
  try {
    const candidates = await fetchCandidates();
    for (const candidate of candidates) {
      await processCandidate(candidate, jobLogger);
    }
  } catch (error) {
    jobLogger.warn({ error }, "No se pudo correr el cazador de ventas");
  }
}
