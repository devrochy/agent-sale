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
  status: "cancelado" | "pedido_no_abierto";
  public_order_number?: string;
}

/**
 * Tool cancelar_pedido — uno de los 3 caminos que abre la plantilla
 * "pedido_confirmado_v3" (ver enviarPedidoConfirmado.ts) cuando el cliente
 * responde "Cancelar pedido" a la plantilla de confirmación. Reutiliza cambiarEstadoPedido, la misma
 * función que usa el panel (ver adminPanel.ts, cancelarPedido) — mismo
 * criterio ahí documentado: cancelar es un cambio de estado, no una
 * devolución, no libera stock ni revierte pagos.
 *
 * Solo cancela un pedido "abierto" — uno ya despachado/entregado no se
 * cancela desde acá (el guard de cambiarEstadoPedido por status distinto
 * ya lo cubre, pero se chequea antes para devolver un status claro al LLM
 * en vez de un "no-op" silencioso).
 */
export async function cancelarPedido(input: CancelarPedidoInput): Promise<CancelarPedidoOutput> {
  const order = await withTransaction(async (client) => {
    const result = await client.query<{ status: string; public_order_number: string }>(
      `SELECT status, public_order_number FROM orders WHERE id = $1`,
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

  await cambiarEstadoPedido(
    input.order_id,
    "cancelado",
    input.reason ? `Cancelado por el cliente: ${input.reason}` : "Cancelado por el cliente desde WhatsApp.",
  );
  // Plantilla "pedido_cancelado" — ver notificarPedidoCancelado.ts para por
  // qué esta llamada, aunque corre en medio de la tool, no rompe la
  // secuencia tool_use/tool_result (no toca appendMessage).
  await notificarPedidoCancelado(input.order_id);

  return { order_id: input.order_id, status: "cancelado", public_order_number: order.public_order_number };
}
