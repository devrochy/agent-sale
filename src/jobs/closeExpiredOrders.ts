import type { Logger } from "pino";
import { sendToConversation } from "../gateway/sendMessage.js";
import { appendMessage } from "../orchestrator/memory.js";
import { withTransaction } from "../shared/db/index.js";
import { logger } from "../shared/observability/logger.js";

interface CandidateRow {
  id: string;
  conversation_id: string;
  public_order_number: string;
  external_id: string;
}

/**
 * Pedidos `pago_en_linea` sin pagar hace 5+ días (Fase 16, ver ADR-034).
 * Solo aplica a `pago_en_linea` — los otros 3 métodos nacen `payment_status
 * = 'pagado'` (ver migrations/0030_orders_payment_status.cjs), así que ya
 * quedan fuera del filtro `payment_status = 'pendiente'`. `status !=
 * 'expirado'` evita re-encolar en cada corrida un pedido ya cerrado por
 * esta misma condición.
 */
async function fetchCandidates(): Promise<CandidateRow[]> {
  return withTransaction(async (client) => {
    const result = await client.query<CandidateRow>(
      `SELECT o.id, o.conversation_id, o.public_order_number, c.external_id
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       WHERE o.payment_method = 'pago_en_linea'
         AND o.payment_status = 'pendiente'
         AND o.status != 'expirado'
         AND o.created_at <= now() - interval '5 days'`,
    );
    return result.rows;
  });
}

function formatExpiredText(publicOrderNumber: string): string {
  return (
    `Tu pedido ${publicOrderNumber} venció sin registrar el pago dentro de los 5 días. ` +
    `Lo dejamos cancelado por ahora — si todavía lo querés, contame y armamos uno nuevo. 😊`
  );
}

/**
 * `UPDATE ... WHERE payment_status = 'pendiente'` es el guard idempotente:
 * si el webhook de Wompi aprobó el pago justo antes de esta corrida, la
 * UPDATE afecta 0 filas y el candidato se salta entero — sin liberar stock
 * ni notificar. Mismo criterio de guard que ya usa wompiWebhookHandler.ts.
 */
async function closeOrder(orderId: string): Promise<boolean> {
  const result = await withTransaction((client) =>
    client.query<{ id: string }>(
      `UPDATE orders SET status = 'expirado' WHERE id = $1 AND payment_status = 'pendiente' RETURNING id`,
      [orderId],
    ),
  );
  return result.rows.length > 0;
}

/**
 * Inverso exacto del descuento de stock de crearPedido.ts: un pedido que
 * nunca se pagó nunca se vendió de verdad, así que esas unidades vuelven al
 * inventario.
 */
async function releaseStock(orderId: string): Promise<void> {
  await withTransaction((client) =>
    client.query(
      `UPDATE inventory i
       SET stock_quantity = i.stock_quantity + oi.quantity
       FROM order_items oi
       WHERE oi.order_id = $1 AND i.variant_id = oi.variant_id`,
      [orderId],
    ),
  );
}

async function processCandidate(candidate: CandidateRow, jobLogger: Logger): Promise<void> {
  const candidateLogger = jobLogger.child({
    conversation_id: candidate.conversation_id,
    order_id: candidate.id,
  });

  let closed: boolean;
  try {
    closed = await closeOrder(candidate.id);
  } catch (error) {
    candidateLogger.warn({ error }, "No se pudo cerrar el pedido expirado");
    return;
  }
  if (!closed) {
    // El pago se aprobó justo antes de esta corrida (o ya estaba expirado):
    // nada más que hacer con este candidato.
    return;
  }

  try {
    await releaseStock(candidate.id);
  } catch (error) {
    candidateLogger.warn({ error }, "Pedido cerrado, pero no se pudo liberar el stock");
  }

  const text = formatExpiredText(candidate.public_order_number);
  let sid: string;
  try {
    sid = await sendToConversation(candidate.conversation_id, text);
  } catch (error) {
    candidateLogger.warn(
      { error },
      "Pedido cerrado, pero no se pudo notificar al cliente por WhatsApp",
    );
    return;
  }

  try {
    await appendMessage(candidate.conversation_id, "outbound", "agent", text);
  } catch (error) {
    candidateLogger.warn(
      { error, sid },
      "Notificación de pedido expirado enviada, pero no se pudo guardar en el historial",
    );
  }
}

/**
 * Recorre todos los pedidos `pago_en_linea` vencidos (best-effort por
 * pedido — que uno falle no debe frenar los demás). Se llama tanto desde el
 * cron (src/jobs/scheduler.ts, diario) como manualmente en QA.
 */
export async function runCloseExpiredOrders(): Promise<void> {
  const jobLogger = logger.child({ event: "jobs.cerrar_pedidos_vencidos" });
  try {
    const candidates = await fetchCandidates();
    for (const candidate of candidates) {
      await processCandidate(candidate, jobLogger);
    }
  } catch (error) {
    jobLogger.warn({ error }, "No se pudo correr el cierre de pedidos vencidos");
  }
}
