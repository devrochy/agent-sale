import type { Logger } from "pino";
import { canonicalToMetaRecipient } from "../gateway/channels/meta/addresses.js";
import { resolveApprovedTemplate } from "../gateway/channels/meta/resolveApprovedTemplate.js";
import { sendTemplateMessage } from "../gateway/channels/meta/templates.js";
import { appendMessage } from "../orchestrator/memory.js";
import { withTransaction } from "../shared/db/index.js";
import { logger } from "../shared/observability/logger.js";

interface ColdCandidateRow {
  quote_id: string;
  conversation_id: string;
  connection_id: string | null;
  external_id: string;
  customer_full_name: string | null;
  total: string;
}

interface QuoteItemRow {
  name: string;
  quantity: number;
}

/**
 * El otro lado de cazadorDeVentas.ts: ese job solo recorre cotizaciones
 * donde el cliente escribió en las últimas 24h (así puede mandar texto
 * libre, gratis). Las que quedan frías más tiempo — sin ese mensaje
 * reciente — hasta ahora no recibían nada: es exactamente el caso que
 * docs/fase-12-capacidades-proactivas-agente/adrs/ADR-019-... marcó como
 * bloqueado "hasta tener plantillas aprobadas por Meta".
 *
 * Reusa `quotes.follow_up_sent_at` como el mismo flag de "ya se intentó
 * reenganchar" que usa cazadorDeVentas.ts — sea por texto libre (cliente
 * todavía dentro de la ventana) o por plantilla acá (cliente ya fuera), una
 * cotización solo se reengancha una vez.
 *
 * Ventana de edad: arranca donde termina la de cazadorDeVentas.ts (20h) y
 * llega hasta 7 días — pasado eso, reactivar una cotización tan vieja tiene
 * cada vez menos sentido de negocio y no vale la pena seguir intentando.
 */
async function fetchColdCandidates(): Promise<ColdCandidateRow[]> {
  return withTransaction(async (client) => {
    const result = await client.query<ColdCandidateRow>(
      `SELECT q.id AS quote_id, q.conversation_id, conv.connection_id, cu.external_id,
              cu.full_name AS customer_full_name, q.total
       FROM quotes q
       JOIN customers cu ON cu.id = q.customer_id
       JOIN conversations conv ON conv.id = q.conversation_id
       WHERE q.follow_up_sent_at IS NULL
         AND q.created_at <= now() - interval '20 hours'
         AND q.created_at >= now() - interval '7 days'
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.quote_id = q.id)
         AND NOT EXISTS (
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
       JOIN product_variants pv ON pv.id = qi.variant_id
       JOIN products p ON p.id = pv.product_id
       WHERE qi.quote_id = $1
       ORDER BY p.name`,
      [quoteId],
    );
    return result.rows;
  });
}

function formatearItems(items: QuoteItemRow[]): string {
  return items.map((item) => (item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name)).join(", ");
}

/**
 * Mismo criterio de idempotencia que processCandidate en cazadorDeVentas.ts:
 * `follow_up_sent_at` se marca apenas la plantilla se manda con éxito, antes
 * de cualquier paso siguiente — si el historial falla después no importa,
 * la próxima corrida no le manda un segundo mensaje al mismo cliente.
 */
async function processColdCandidate(candidate: ColdCandidateRow, jobLogger: Logger): Promise<void> {
  const candidateLogger = jobLogger.child({
    conversation_id: candidate.conversation_id,
    quote_id: candidate.quote_id,
  });

  const resuelta = await resolveApprovedTemplate(candidate.connection_id, "carrito_abandonado");
  if (!resuelta.ok) {
    // No es un error: la plantilla puede no estar aprobada todavía. La
    // cotización sigue candidata en la próxima corrida (no se marca
    // follow_up_sent_at).
    return;
  }

  let items: QuoteItemRow[];
  try {
    items = await fetchQuoteItems(candidate.quote_id);
  } catch (error) {
    candidateLogger.warn({ error }, "No se pudo armar la plantilla de reactivación para esta cotización");
    return;
  }

  const nombre = candidate.customer_full_name || "cliente";
  const itemsText = formatearItems(items);
  const monto = `$${Number(candidate.total).toLocaleString("es-CO")}`;

  try {
    await sendTemplateMessage(
      resuelta.connection.credentials,
      resuelta.connection.externalId,
      canonicalToMetaRecipient(candidate.external_id),
      "carrito_abandonado",
      resuelta.template.language,
      [
        {
          type: "body",
          parameters: [
            { type: "text", text: nombre },
            { type: "text", text: itemsText },
            { type: "text", text: monto },
          ],
        },
      ],
    );
  } catch (error) {
    candidateLogger.warn(
      { error },
      "No se pudo mandar la plantilla de reactivación — se reintenta en la próxima corrida",
    );
    return;
  }

  try {
    await withTransaction((client) =>
      client.query("UPDATE quotes SET follow_up_sent_at = now() WHERE id = $1", [candidate.quote_id]),
    );
  } catch (error) {
    candidateLogger.warn(
      { error },
      "Plantilla de reactivación enviada, pero no se pudo marcar follow_up_sent_at — podría reenviarse en la próxima corrida",
    );
  }

  try {
    await appendMessage(
      candidate.conversation_id,
      "outbound",
      "agent",
      `Hola ${nombre}! Vimos que estabas interesado en ${itemsText} por ${monto}. ¿Seguís interesado/a? Contanos y seguimos con tu pedido.`,
    );
  } catch (error) {
    candidateLogger.warn({ error }, "Plantilla de reactivación enviada, pero no se pudo guardar en el historial");
  }
}

/**
 * Recorre las cotizaciones frías candidatas (best-effort por cotización).
 * Se llama desde el cron (src/jobs/scheduler.ts, misma cadencia horaria que
 * cazadorDeVentas.ts) y manualmente en QA.
 */
export async function runReactivarCotizacionesFrias(): Promise<void> {
  const jobLogger = logger.child({ event: "jobs.reactivar_cotizaciones_frias" });
  try {
    const candidates = await fetchColdCandidates();
    for (const candidate of candidates) {
      await processColdCandidate(candidate, jobLogger);
    }
  } catch (error) {
    jobLogger.warn({ error }, "No se pudo correr la reactivación de cotizaciones frías");
  }
}
