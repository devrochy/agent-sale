import { withTransaction } from "../../shared/db/index.js";
import { enviarDatosTransferencia } from "./datosTransferencia.js";

export interface ConfirmarPagoPedidoInput {
  order_id: string;
}

export type ConfirmarPagoPedidoStatus =
  | "datos_transferencia_enviados"
  | "sin_cuentas_configuradas"
  | "link_pago_disponible"
  | "sin_link_pago"
  | "ya_pagado"
  | "sin_pago_pendiente"
  | "pedido_cancelado"
  | "pedido_no_encontrado";

export interface ConfirmarPagoPedidoOutput {
  order_id: string;
  status: ConfirmarPagoPedidoStatus;
  payment_link_url?: string;
}

interface OrderPaymentRow {
  status: string;
  payment_method: string;
  payment_status: string;
  wompi_payment_link_url: string | null;
  conversation_id: string;
  public_order_number: string;
  total: string;
}

/**
 * Tool confirmar_pago_pedido — resuelve el botón "Confirmar y pagar" de la
 * plantilla `pedido_confirmado`. Hasta esta versión ese botón era un link
 * fijo (`.../pago/{{1}}`) a un sitio que nunca se conectó a este backend; se
 * reemplaza por un Quick Reply que el LLM interpreta como cualquier tap, y
 * esta tool decide qué mandar según el método de pago ya elegido en
 * `crear_pedido` (`orders.payment_method`) — no hace falta volver a
 * preguntarlo.
 *
 * - `transferencia`: reusa `enviarDatosTransferencia` (mismo criterio que
 *   `crearPedido.ts` — el texto de la cuenta nunca pasa por el LLM, ver el
 *   docblock de `datosTransferencia.ts`).
 * - `pago_en_linea`: el link ya se generó y se guardó al crear el pedido
 *   (`orders.wompi_payment_link_url`, ver `wompiPaymentLinkDirectory.ts`) —
 *   se reenvía el mismo, no se genera uno nuevo.
 * - `efectivo_contraentrega`/`tarjeta`: no hay nada que pagar por adelantado.
 */
export async function confirmarPagoPedido(input: ConfirmarPagoPedidoInput): Promise<ConfirmarPagoPedidoOutput> {
  const order = await withTransaction(async (client) => {
    const result = await client.query<OrderPaymentRow>(
      `SELECT status, payment_method, payment_status, wompi_payment_link_url,
              conversation_id, public_order_number, total
         FROM orders WHERE id = $1`,
      [input.order_id],
    );
    return result.rows[0] ?? null;
  });

  if (!order) {
    return { order_id: input.order_id, status: "pedido_no_encontrado" };
  }
  if (order.status === "cancelado" || order.status === "expirado") {
    return { order_id: input.order_id, status: "pedido_cancelado" };
  }

  switch (order.payment_method) {
    case "transferencia": {
      const enviados = await enviarDatosTransferencia(
        order.conversation_id,
        order.public_order_number,
        Number(order.total),
      );
      return {
        order_id: input.order_id,
        status: enviados ? "datos_transferencia_enviados" : "sin_cuentas_configuradas",
      };
    }
    case "pago_en_linea": {
      // payment_status nace en 'pendiente' solo para este método (ver
      // migración 0030) — si ya está 'pagado', Wompi ya confirmó el pago.
      if (order.payment_status === "pagado") {
        return { order_id: input.order_id, status: "ya_pagado" };
      }
      if (!order.wompi_payment_link_url) {
        return { order_id: input.order_id, status: "sin_link_pago" };
      }
      return {
        order_id: input.order_id,
        status: "link_pago_disponible",
        payment_link_url: order.wompi_payment_link_url,
      };
    }
    default:
      // efectivo_contraentrega / tarjeta: payment_status nace en 'pagado'
      // para estos métodos (sin seguimiento en línea), no significa que ya
      // se cobró — simplemente no hay nada pendiente de pagar por acá.
      return { order_id: input.order_id, status: "sin_pago_pendiente" };
  }
}
