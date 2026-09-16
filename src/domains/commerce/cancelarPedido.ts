import { escalarHumano } from "../escalation/escalarHumano.js";
import { withTransaction } from "../../shared/db/index.js";
import { cambiarEstadoPedido } from "./estadoPedido.js";
import { notificarPedidoCancelado } from "./notificarPedidoCancelado.js";

export interface CancelarPedidoInput {
  order_id: string;
  /** Motivo que da el cliente, si lo dice (ej. "cambié de opinión"). Opcional. */
  reason?: string;
}

export interface CancelarPedidoOutput {
  order_id: string;
  status: "cancelado" | "cancelacion_pendiente_aprobacion" | "pedido_no_abierto";
  public_order_number?: string;
}

/**
 * Inverso exacto del descuento de stock de crearPedido.ts (mismo criterio
 * de duplicar el query en vez de extraer un módulo compartido que ya usa
 * el proyecto entre crearPedido.ts/agregarItemPedido.ts) — copiado tal
 * cual de closeExpiredOrders.ts: un pedido cancelado nunca se vendió de
 * verdad, esas unidades vuelven al inventario.
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

/**
 * Tool cancelar_pedido — uno de los 3 caminos que abre la plantilla
 * "pedido_confirmado_v3" (ver enviarPedidoConfirmado.ts) cuando el cliente
 * responde "Cancelar pedido" a la plantilla de confirmación. Reutiliza
 * cambiarEstadoPedido, la misma función que usa el panel (ver
 * adminPanel.ts, cancelarPedido).
 *
 * Solo cancela un pedido "abierto" — uno ya despachado/entregado no se
 * cancela desde acá (el guard de cambiarEstadoPedido por status distinto
 * ya lo cubre, pero se chequea antes para devolver un status claro al LLM
 * en vez de un "no-op" silencioso).
 *
 * Pedido `pagado` **por transferencia o pago en línea**: no cancela de
 * inmediato. Esos dos son los únicos métodos donde `payment_status='pagado'`
 * significa que la plata ya entró de verdad antes de esta cancelación —
 * `efectivo_contraentrega`/`tarjeta` también nacen en `'pagado'`
 * (crearPedido.ts, ver migrations/0030) pero ahí es un default histórico,
 * no un cobro real (se paga recién al entregar). Cancelar un pedido con
 * plata ya cobrada implica devolvérsela al cliente, y eso no lo puede
 * resolver solo el bot — queda "solicitada"
 * (orders.cancellation_requested_at) y escala a un admin, que la aprueba
 * desde el panel después de gestionar la devolución por fuera del sistema
 * (ver adminPanel.ts, aprobarCancelacionPedido). Recién ahí se libera el
 * stock y se manda la plantilla "pedido_cancelado".
 */
const METODOS_CON_COBRO_REAL = new Set(["transferencia", "pago_en_linea"]);

export async function cancelarPedido(input: CancelarPedidoInput): Promise<CancelarPedidoOutput> {
  const order = await withTransaction(async (client) => {
    const result = await client.query<{
      status: string;
      payment_status: string;
      payment_method: string;
      public_order_number: string;
      conversation_id: string;
    }>(
      `SELECT status, payment_status, payment_method, public_order_number, conversation_id FROM orders WHERE id = $1`,
      [input.order_id],
    );
    return result.rows[0] ?? null;
  });

  if (!order || order.status !== "abierto") {
    return {
      order_id: input.order_id,
      status: "pedido_no_abierto",
      public_order_number: order?.public_order_number,
    };
  }

  if (order.payment_status === "pagado" && METODOS_CON_COBRO_REAL.has(order.payment_method)) {
    const marcado = await withTransaction((client) =>
      client.query<{ id: string }>(
        `UPDATE orders SET cancellation_requested_at = now(), cancellation_reason = $2
          WHERE id = $1 AND cancellation_requested_at IS NULL
        RETURNING id`,
        [input.order_id, input.reason ?? null],
      ),
    );
    if (marcado.rows.length > 0) {
      await escalarHumano(order.conversation_id, {
        reason: "cancelacion_pedido_pagado",
        summary: `El cliente pidió cancelar el pedido ${order.public_order_number} (ya pagado)${
          input.reason ? `: ${input.reason}` : "."
        } Hace falta gestionar la devolución antes de aprobar la cancelación.`,
      });
    }
    return {
      order_id: input.order_id,
      status: "cancelacion_pendiente_aprobacion",
      public_order_number: order.public_order_number,
    };
  }

  await cambiarEstadoPedido(
    input.order_id,
    "cancelado",
    input.reason ? `Cancelado por el cliente: ${input.reason}` : "Cancelado por el cliente desde WhatsApp.",
  );
  await releaseStock(input.order_id);
  // Plantilla "pedido_cancelado" — ver notificarPedidoCancelado.ts para por
  // qué esta llamada, aunque corre en medio de la tool, no rompe la
  // secuencia tool_use/tool_result (no toca appendMessage).
  await notificarPedidoCancelado(input.order_id);

  return { order_id: input.order_id, status: "cancelado", public_order_number: order.public_order_number };
}
