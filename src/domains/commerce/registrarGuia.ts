import { canonicalToMetaRecipient } from "../../gateway/channels/meta/addresses.js";
import { resolveApprovedTemplate } from "../../gateway/channels/meta/resolveApprovedTemplate.js";
import { sendTemplateMessage } from "../../gateway/channels/meta/templates.js";
import { sendToConversation } from "../../gateway/sendMessage.js";
import { appendMessage } from "../../orchestrator/memory.js";
import { withTransaction } from "../../shared/db/index.js";

export interface RegistrarGuiaInput {
  trackingNumber: string;
  carrier: string;
}

export type RegistrarGuiaOutput = { ok: true } | { ok: false; error: string };

function textoEnCamino(publicOrderNumber: string, trackingNumber: string, carrier: string): string {
  return `¡Buenas noticias! Tu pedido ${publicOrderNumber} ya está en camino. Guía ${trackingNumber} (${carrier}).`;
}

/**
 * Registrar guía desde el panel (Fase 16, ver ADR-034). `shipped_at` es el
 * guard de idempotencia de la notificación: `isFirstTime` (shipped_at
 * IS NULL) decide si se manda el WhatsApp, pero el UPDATE siempre permite
 * corregir tracking_number/carrier después — `COALESCE(shipped_at, now())`
 * no pisa el timestamp original de despacho ni vuelve a notificar.
 *
 * Exige `address_confirmed_at` no nulo antes de aceptar la guía (pedido del
 * usuario: "paso obligatorio antes de despachar" — ver
 * confirmarDomicilioPedido.ts, que es quien lo pone en `now()` cuando el
 * cliente toca el botón de la plantilla "confirmar_domicilio" que manda
 * cerrarPedido.ts). El admin tiene una válvula de escape en el panel para
 * marcarlo a mano si ya lo verificó por otro medio (ver adminPanel.ts).
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
      address_confirmed_at: string | null;
      conversation_id: string;
      connection_id: string | null;
      public_order_number: string;
      external_id: string;
    }>(
      `SELECT o.shipped_at, o.address_confirmed_at, o.conversation_id, conv.connection_id,
              o.public_order_number, c.external_id
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN conversations conv ON conv.id = o.conversation_id
       WHERE o.id = $1
       FOR UPDATE OF o`,
      [orderId],
    );
    const order = orderResult.rows[0];
    if (!order) {
      return { kind: "no_encontrado" as const };
    }
    if (!order.address_confirmed_at) {
      return { kind: "domicilio_sin_confirmar" as const };
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
      kind: "ok" as const,
      isFirstTime,
      conversationId: order.conversation_id,
      connectionId: order.connection_id,
      publicOrderNumber: order.public_order_number,
      phoneNumber: order.external_id,
    };
  });

  if (updated.kind === "no_encontrado") {
    return { ok: false, error: "Pedido no encontrado." };
  }
  if (updated.kind === "domicilio_sin_confirmar") {
    return {
      ok: false,
      error:
        "El cliente todavía no confirmó su dirección — no se puede despachar hasta que confirme, o reenviá la plantilla de confirmación desde el pedido.",
    };
  }

  if (updated.isFirstTime) {
    const text = textoEnCamino(updated.publicOrderNumber, trackingNumber, carrier);
    try {
      // Se intenta primero como plantilla (llega también fuera de la
      // ventana de 24h, caso común: el despacho ocurre días después de que
      // el cliente escribió). Si "pedido_en_camino" todavía no está
      // aprobada por Meta, se cae al texto libre de siempre — no es un
      // cambio de comportamiento obligatorio, solo una mejora de alcance.
      const plantilla = await resolveApprovedTemplate(updated.connectionId, "pedido_en_camino");
      if (plantilla.ok) {
        await sendTemplateMessage(
          plantilla.connection.credentials,
          plantilla.connection.externalId,
          canonicalToMetaRecipient(updated.phoneNumber),
          "pedido_en_camino",
          plantilla.template.language,
          [
            {
              type: "body",
              parameters: [
                { type: "text", text: updated.publicOrderNumber },
                { type: "text", text: trackingNumber },
                { type: "text", text: carrier },
              ],
            },
          ],
        );
      } else {
        await sendToConversation(updated.conversationId, text);
      }
      await appendMessage(updated.conversationId, "outbound", "agent", text);
    } catch {
      // Best-effort — un fallo de WhatsApp o de historial no debe romper el
      // guardado del admin, la guía ya quedó registrada.
    }
  }

  return { ok: true };
}
