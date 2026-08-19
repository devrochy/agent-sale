import { sendToConversation } from "../../gateway/sendMessage.js";
import { appendMessage } from "../../orchestrator/memory.js";
import { withTransaction } from "../../shared/db/index.js";

export interface RegistrarGuiaInput {
  trackingNumber: string;
  carrier: string;
}

export type RegistrarGuiaOutput = { ok: true } | { ok: false; error: string };

/**
 * Registrar guía desde el panel (Fase 16, ver ADR-034). `shipped_at` es el
 * guard de idempotencia de la notificación: `isFirstTime` (shipped_at
 * IS NULL) decide si se manda el WhatsApp, pero el UPDATE siempre permite
 * corregir tracking_number/carrier después — `COALESCE(shipped_at, now())`
 * no pisa el timestamp original de despacho ni vuelve a notificar.
 */
export async function registrarGuia(orderId: string, input: RegistrarGuiaInput): Promise<RegistrarGuiaOutput> {
  const trackingNumber = input.trackingNumber.trim();
  const carrier = input.carrier.trim();
  if (!trackingNumber) {
    return { ok: false, error: "El número de guía es obligatorio." };
  }
  if (!carrier) {
    return { ok: false, error: "La transportadora es obligatoria." };
  }

  const updated = await withTransaction(async (client) => {
    const orderResult = await client.query<{
      shipped_at: string | null;
      conversation_id: string;
      public_order_number: string;
      external_id: string;
    }>(
      `SELECT o.shipped_at, o.conversation_id, o.public_order_number, c.external_id
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       WHERE o.id = $1
       FOR UPDATE OF o`,
      [orderId],
    );
    const order = orderResult.rows[0];
    if (!order) {
      return null;
    }
    const isFirstTime = order.shipped_at === null;

    // Registrar la guía ES el despacho: hasta ahora se marcaba `shipped_at`
    // pero `status` se quedaba en 'abierto', así que el pedido despachado no
    // se distinguía del que todavía no salió. El estado se mueve acá y no en
    // una acción aparte para que no haya forma de tener guía sin despachar.
    // 'entregado' y 'cancelado' siguen siendo decisión de un humano.
    await client.query(
      `UPDATE orders
       SET tracking_number = $2, carrier = $3, shipped_at = COALESCE(shipped_at, now()),
           status = CASE WHEN status = 'abierto' THEN 'despachado' ELSE status END,
           status_changed_at = CASE WHEN status = 'abierto' THEN now() ELSE status_changed_at END
       WHERE id = $1`,
      [orderId, trackingNumber, carrier],
    );

    return {
      isFirstTime,
      conversationId: order.conversation_id,
      publicOrderNumber: order.public_order_number,
      phoneNumber: order.external_id,
    };
  });

  if (!updated) {
    return { ok: false, error: "Pedido no encontrado." };
  }

  if (updated.isFirstTime) {
    const text =
      `¡Buenas noticias! Tu pedido ${updated.publicOrderNumber} ya está en camino. ` +
      `Guía ${trackingNumber} (${carrier}).`;
    try {
      await sendToConversation(updated.conversationId, text);
      await appendMessage(updated.conversationId, "outbound", "agent", text);
    } catch {
      // Best-effort — un fallo de WhatsApp o de historial no debe romper el
      // guardado del admin, la guía ya quedó registrada.
    }
  }

  return { ok: true };
}
