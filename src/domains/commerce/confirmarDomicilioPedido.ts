import { canonicalToMetaRecipient } from "../../gateway/channels/meta/addresses.js";
import { resolveApprovedTemplate } from "../../gateway/channels/meta/resolveApprovedTemplate.js";
import { sendTemplateMessage } from "../../gateway/channels/meta/templates.js";
import { withTransaction } from "../../shared/db/index.js";

export interface ConfirmarDomicilioPedidoInput {
  order_id: string;
}

export type ConfirmarDomicilioPedidoStatus = "confirmado" | "pedido_no_abierto";

export interface ConfirmarDomicilioPedidoOutput {
  order_id: string;
  status: ConfirmarDomicilioPedidoStatus;
}

/**
 * Tool confirmar_domicilio_pedido — el otro lado de la plantilla
 * "confirmar_domicilio" que manda cerrarPedido.ts. Cuando el cliente toca
 * el botón "Confirmar dirección", el LLM la interpreta como cualquier tap
 * (llega como texto, ver inbound.ts) y llama esta tool con el order_id de
 * la conversación.
 *
 * `registrarGuia.ts` exige `address_confirmed_at IS NOT NULL` antes de
 * aceptar una guía — este es el único lugar (aparte del botón manual del
 * panel, ver adminPanel.ts) que lo pone en `now()`. El guard por
 * `status = 'abierto'` evita que una confirmación tardía pise algo en un
 * pedido que ya avanzó de estado por otro lado.
 */
export async function confirmarDomicilioPedido(
  input: ConfirmarDomicilioPedidoInput,
): Promise<ConfirmarDomicilioPedidoOutput> {
  const confirmado = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE orders SET address_confirmed_at = now()
        WHERE id = $1 AND status = 'abierto'`,
      [input.order_id],
    );
    return (result.rowCount ?? 0) > 0;
  });

  return {
    order_id: input.order_id,
    status: confirmado ? "confirmado" : "pedido_no_abierto",
  };
}

interface OrderAddressRow {
  status: string;
  public_order_number: string;
  delivery_address: string | null;
  delivery_method: string;
  customer_external_id: string;
  connection_id: string | null;
}

async function fetchOrderAddress(orderId: string): Promise<OrderAddressRow | null> {
  return withTransaction(async (client) => {
    const result = await client.query<OrderAddressRow>(
      `SELECT o.status, o.public_order_number, o.delivery_address, o.delivery_method,
              c.external_id AS customer_external_id, conv.connection_id
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         JOIN conversations conv ON conv.id = o.conversation_id
        WHERE o.id = $1`,
      [orderId],
    );
    return result.rows[0] ?? null;
  });
}

export type ReenviarConfirmacionDomicilioResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Botón "Reenviar confirmación" del panel (diálogo de guía, ver
 * adminPanel.ts) — para cuando el cliente nunca respondió al primer envío
 * de cerrarPedido.ts, o la plantilla recién se aprobó después del cierre
 * del pedido.
 */
export async function reenviarConfirmacionDomicilio(orderId: string): Promise<ReenviarConfirmacionDomicilioResult> {
  const order = await fetchOrderAddress(orderId);
  if (!order) {
    return { ok: false, error: "Pedido no encontrado." };
  }
  const resuelta = await resolveApprovedTemplate(order.connection_id, "confirmar_domicilio");
  if (!resuelta.ok) {
    return {
      ok: false,
      error:
        resuelta.status === "plantilla_no_aprobada"
          ? "La plantilla 'confirmar_domicilio' todavía no está aprobada por Meta."
          : "Esta conexión no admite plantillas de Meta.",
    };
  }
  await sendTemplateMessage(
    resuelta.connection.credentials,
    resuelta.connection.externalId,
    canonicalToMetaRecipient(order.customer_external_id),
    "confirmar_domicilio",
    resuelta.template.language,
    [
      {
        type: "body",
        parameters: [
          { type: "text", text: order.public_order_number },
          { type: "text", text: order.delivery_address ?? order.delivery_method },
        ],
      },
    ],
  );
  return { ok: true };
}

/**
 * Válvula de escape del panel: el admin ya verificó la dirección por otro
 * medio (llamada, otro canal) y no quiere esperar a que el cliente
 * responda el botón — marca `address_confirmed_at` directo. Se audita con
 * `adminUsername` en el motivo, mismo criterio que `cancelarPedido`
 * (adminPanel.ts) para las transiciones que alguien puede preguntar
 * "¿y esto por qué?" después.
 */
export async function confirmarDomicilioManual(orderId: string, adminUsername: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE orders SET address_confirmed_at = now(), status_reason = $2
        WHERE id = $1 AND status = 'abierto' AND address_confirmed_at IS NULL`,
      [orderId, `Domicilio confirmado a mano por ${adminUsername}.`],
    );
    return (result.rowCount ?? 0) > 0;
  });
}
