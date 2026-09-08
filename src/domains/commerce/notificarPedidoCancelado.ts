import { withTransaction } from "../../shared/db/index.js";
import { canonicalToMetaRecipient } from "../../gateway/channels/meta/addresses.js";
import { resolveApprovedTemplate } from "../../gateway/channels/meta/resolveApprovedTemplate.js";
import { sendTemplateMessage } from "../../gateway/channels/meta/templates.js";

interface OrderRow {
  conversation_id: string;
  public_order_number: string;
  customer_external_id: string;
  connection_id: string | null;
}

/**
 * Plantilla "pedido_cancelado" — se llama desde los dos lugares que ya
 * cancelan un pedido: la tool cancelar_pedido (LLM) y `cancelarPedido` del
 * panel (adminPanel.ts). Sin ella, cancelar fuera de la ventana de 24h
 * (típico cuando lo hace un admin días después) no le llega nada al
 * cliente por WhatsApp — solo quedaba el texto libre que el LLM redacta en
 * su propio turno, que no existe cuando cancela un humano desde el panel.
 *
 * A propósito NO llama appendMessage: puede correr en medio de la
 * ejecución de la tool cancelar_pedido, mismo riesgo documentado en
 * enviarPedidoConfirmado.ts (rompe la secuencia tool_use→tool_result de la
 * API del LLM). El caller del panel, que sí corre fuera de ese loop, puede
 * loguearlo aparte si hace falta.
 */
export async function notificarPedidoCancelado(orderId: string): Promise<void> {
  const order = await withTransaction(async (client) => {
    const result = await client.query<OrderRow>(
      `SELECT o.conversation_id, o.public_order_number, c.external_id AS customer_external_id,
              conv.connection_id
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         JOIN conversations conv ON conv.id = o.conversation_id
        WHERE o.id = $1`,
      [orderId],
    );
    return result.rows[0] ?? null;
  });
  if (!order) return;

  const resuelta = await resolveApprovedTemplate(order.connection_id, "pedido_cancelado");
  if (!resuelta.ok) return;

  await sendTemplateMessage(
    resuelta.connection.credentials,
    resuelta.connection.externalId,
    canonicalToMetaRecipient(order.customer_external_id),
    "pedido_cancelado",
    resuelta.template.language,
    [{ type: "body", parameters: [{ type: "text", text: order.public_order_number }] }],
  );
}
