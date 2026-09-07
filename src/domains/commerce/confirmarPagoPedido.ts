import { withTransaction } from "../../shared/db/index.js";
import { enviarDatosTransferencia } from "./datosTransferencia.js";

export interface ConfirmarPagoPedidoInput {
  order_id: string;
}

export type ConfirmarPagoPedidoStatus =
  | "datos_transferencia_enviados"
  | "sin_cuentas_configuradas"
  | "error_envio_transferencia"
  | "link_pago_disponible"
  | "sin_link_pago"
  | "ya_pagado"
  | "pago_rechazado"
  | "sin_pago_pendiente"
  | "pedido_no_abierto"
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
 *   docblock de `datosTransferencia.ts`). Distingue "sin cuentas cargadas"
 *   de "el envío falló" — son diagnósticos distintos, y confundirlos le
 *   hace decir al LLM algo falso.
 * - `pago_en_linea`: el link ya se generó y se guardó al crear el pedido
 *   (`orders.wompi_payment_link_url`, ver `wompiPaymentLinkDirectory.ts`) —
 *   se reenvía el mismo, no se genera uno nuevo. Si Wompi ya lo rechazó
 *   (`payment_status = 'rechazado'`, ver `marcarPagoRechazado` en
 *   `estadoPedido.ts`), NO se reenvía ese link muerto — según
 *   `wompiWebhookHandler.ts`, un reintento necesita un pedido nuevo.
 * - `efectivo_contraentrega`/`tarjeta`: no hay nada que pagar por adelantado.
 *
 * Guard por `status = 'abierto'`, igual que el resto de las tools de pedido
 * (`confirmarDomicilioPedido.ts`, `actualizarDireccionPedido.ts`) — un
 * pedido ya cancelado, despachado o entregado no debería reenviar datos de
 * pago por un tap tardío de un botón viejo.
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
  if (order.status !== "abierto") {
    return { order_id: input.order_id, status: "pedido_no_abierto" };
  }

  switch (order.payment_method) {
    case "transferencia": {
      const resultado = await enviarDatosTransferencia(
        order.conversation_id,
        order.public_order_number,
        Number(order.total),
      );
      const status: ConfirmarPagoPedidoStatus =
        resultado === "enviado"
          ? "datos_transferencia_enviados"
          : resultado === "sin_cuentas"
            ? "sin_cuentas_configuradas"
            : "error_envio_transferencia";
      return { order_id: input.order_id, status };
    }
    case "pago_en_linea": {
      // payment_status nace en 'pendiente' solo para este método (ver
      // migración 0030) — 'pagado' es que Wompi ya lo confirmó, 'rechazado'
      // que ya lo rechazó (migración 0056). En ninguno de los dos casos
      // corresponde reenviar el link: uno ya no lo necesita, el otro ya no
      // sirve.
      if (order.payment_status === "pagado") {
        return { order_id: input.order_id, status: "ya_pagado" };
      }
      if (order.payment_status === "rechazado") {
        return { order_id: input.order_id, status: "pago_rechazado" };
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
