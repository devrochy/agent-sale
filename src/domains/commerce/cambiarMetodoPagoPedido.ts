import {
  createWompiPaymentLink,
  getWompiConfig,
  guardarPaymentLinkUrl,
  withTransaction,
} from "../../shared/db/index.js";
import { createPaymentLink, MIN_AMOUNT_COP } from "../../payments/wompiClient.js";
import { canonicalToMetaRecipient } from "../../gateway/channels/meta/addresses.js";
import { resolveApprovedTemplate } from "../../gateway/channels/meta/resolveApprovedTemplate.js";
import { sendTemplateMessage } from "../../gateway/channels/meta/templates.js";
import { enviarDatosTransferencia } from "./datosTransferencia.js";
import type { PaymentMethod } from "./crearPedido.js";

function formatearMonto(total: number): string {
  return `$${total.toLocaleString("es-CO")}`;
}

interface OrderPaymentContextRow {
  status: string;
  conversation_id: string;
  total: string;
  public_order_number: string;
  customer_full_name: string | null;
  customer_external_id: string;
  connection_id: string | null;
}

async function fetchOrderPaymentContext(orderId: string): Promise<OrderPaymentContextRow | null> {
  return withTransaction(async (client) => {
    const result = await client.query<OrderPaymentContextRow>(
      `SELECT o.status, o.conversation_id, o.total, o.public_order_number,
              c.full_name AS customer_full_name, c.external_id AS customer_external_id,
              conv.connection_id
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         JOIN conversations conv ON conv.id = o.conversation_id
        WHERE o.id = $1`,
      [orderId],
    );
    return result.rows[0] ?? null;
  });
}

export interface PedirCambioMetodoPagoInput {
  order_id: string;
}

export type PedirCambioMetodoPagoStatus =
  | "enviado"
  | "pedido_no_abierto"
  | "plantilla_no_aprobada"
  | "canal_no_soportado";

export interface PedirCambioMetodoPagoOutput {
  order_id: string;
  status: PedirCambioMetodoPagoStatus;
}

/**
 * Tool cambiar_metodo_pago_pedido — mismo patrón que preguntarMetodoPago.ts
 * (manda la plantilla "metodo_pago"), pero atada a un pedido YA confirmado
 * en vez de a una cotización: no hay `quote_id` para reusar una vez que el
 * pedido existe. Se llama desde el flujo de "agregar producto" (ver
 * agregarItemPedido.ts / systemPrompt.ts) cuando el cliente quiere cambiar
 * el método de pago de un pedido que ya tiene uno. El botón que responda
 * el cliente se resuelve con `actualizarMetodoPagoPedido`, no con
 * `crear_pedido` (ese es solo para el pedido nuevo).
 */
export async function pedirCambioMetodoPago(
  input: PedirCambioMetodoPagoInput,
): Promise<PedirCambioMetodoPagoOutput> {
  const order = await fetchOrderPaymentContext(input.order_id);
  if (!order || order.status !== "abierto") {
    return { order_id: input.order_id, status: "pedido_no_abierto" };
  }

  const resuelta = await resolveApprovedTemplate(order.connection_id, "metodo_pago");
  if (!resuelta.ok) {
    return { order_id: input.order_id, status: resuelta.status };
  }

  await sendTemplateMessage(
    resuelta.connection.credentials,
    resuelta.connection.externalId,
    canonicalToMetaRecipient(order.customer_external_id),
    "metodo_pago",
    resuelta.template.language,
    [
      {
        type: "body",
        parameters: [
          { type: "text", text: order.customer_full_name || "cliente" },
          { type: "text", text: formatearMonto(Number(order.total)) },
        ],
      },
    ],
  );

  return { order_id: input.order_id, status: "enviado" };
}

export interface ActualizarMetodoPagoPedidoInput {
  order_id: string;
  payment_method: PaymentMethod;
}

export type ActualizarMetodoPagoPedidoStatus =
  | "actualizado"
  | "pedido_no_abierto"
  | "wompi_no_configurado"
  | "wompi_monto_minimo";

export interface ActualizarMetodoPagoPedidoOutput {
  order_id: string;
  status: ActualizarMetodoPagoPedidoStatus;
  /** Solo presente cuando status es "actualizado" y el método nuevo es 'pago_en_linea'. */
  payment_link_url?: string;
  /** Solo presente cuando status es "actualizado" y el método nuevo es 'transferencia'. */
  transfer_details_sent?: boolean;
}

/**
 * Tool actualizar_metodo_pago_pedido — resuelve el botón que el cliente
 * tocó en respuesta a `cambiar_metodo_pago_pedido`. Mismo criterio de
 * `payment_status` que `crearPedido.ts` ('pendiente' para pago_en_linea o
 * transferencia, 'pagado' para el resto — acá no hay tracking real de esos
 * dos métodos). El link de pago viejo (si había uno pendiente) se limpia
 * al cambiar de método: no tiene sentido dejarlo colgado apuntando a un
 * método que el cliente ya no eligió.
 */
export async function actualizarMetodoPagoPedido(
  input: ActualizarMetodoPagoPedidoInput,
): Promise<ActualizarMetodoPagoPedidoOutput> {
  const order = await fetchOrderPaymentContext(input.order_id);
  if (!order || order.status !== "abierto") {
    return { order_id: input.order_id, status: "pedido_no_abierto" };
  }
  const total = Number(order.total);

  let paymentLink: { paymentLinkId: string; url: string } | null = null;
  if (input.payment_method === "pago_en_linea") {
    const wompiConfig = await getWompiConfig();
    if (!wompiConfig.privateKey) {
      return { order_id: input.order_id, status: "wompi_no_configurado" };
    }
    if (total < MIN_AMOUNT_COP) {
      return { order_id: input.order_id, status: "wompi_monto_minimo" };
    }
    paymentLink = await createPaymentLink(
      wompiConfig.privateKey,
      `Pedido ForMotos — cambio de método ${input.order_id}`,
      total,
    );
  }

  const paymentStatus = paymentLink || input.payment_method === "transferencia" ? "pendiente" : "pagado";
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE orders SET payment_method = $1, payment_status = $2, wompi_payment_link_id = $3
        WHERE id = $4 AND status = 'abierto'`,
      [input.payment_method, paymentStatus, paymentLink?.paymentLinkId ?? null, input.order_id],
    );
  });

  if (paymentLink) {
    await createWompiPaymentLink(input.order_id, paymentLink.paymentLinkId);
    await guardarPaymentLinkUrl(input.order_id, paymentLink.url);
    return { order_id: input.order_id, status: "actualizado", payment_link_url: paymentLink.url };
  }

  if (input.payment_method === "transferencia") {
    const resultado = await enviarDatosTransferencia(order.conversation_id, order.public_order_number, total);
    return { order_id: input.order_id, status: "actualizado", transfer_details_sent: resultado === "enviado" };
  }

  return { order_id: input.order_id, status: "actualizado" };
}
