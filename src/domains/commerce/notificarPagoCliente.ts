import { env } from "../../config/env.js";
import { appendMessage } from "../../orchestrator/memory.js";
import { createReviewToken, withTransaction } from "../../shared/db/index.js";
import { canonicalToMetaRecipient } from "../../gateway/channels/meta/addresses.js";
import {
  findUrlButtonIndex,
  resolveApprovedTemplate,
} from "../../gateway/channels/meta/resolveApprovedTemplate.js";
import { sendTemplateMessage } from "../../gateway/channels/meta/templates.js";

/**
 * Notificaciones al CLIENTE del resultado de su pago — a diferencia de
 * `notificarAdmins` en wompiWebhookHandler.ts (que ya existía y sigue
 * avisándole al negocio), estas dos funciones son las que le llegan al
 * comprador. Corren siempre disparadas desde el webhook de Wompi, nunca
 * desde dentro de una tool del LLM — por eso, a diferencia de
 * cerrarPedido.ts, SÍ pueden usar appendMessage: no hay ningún tool_use en
 * curso cuya secuencia con su tool_result se pueda romper.
 */

function formatearMonto(total: number): string {
  return `$${total.toLocaleString("es-CO")}`;
}

interface OrderRow {
  conversation_id: string;
  public_order_number: string;
  customer_external_id: string;
  connection_id: string | null;
  total: string;
}

async function fetchOrder(orderId: string): Promise<OrderRow | null> {
  return withTransaction(async (client) => {
    const result = await client.query<OrderRow>(
      `SELECT o.conversation_id, o.public_order_number, o.total, c.external_id AS customer_external_id,
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

function buildReviewLink(token: string): string {
  return `${new URL(env.publicWebhookUrl).origin}/resena/${token}`;
}

/** Plantilla "pago_aprobado" — body (número de pedido, monto) + botón URL "Dejar reseña" con el token de reseña como sufijo dinámico. */
export async function notificarClientePagoAprobado(orderId: string): Promise<void> {
  const order = await fetchOrder(orderId);
  if (!order) return;

  const resuelta = await resolveApprovedTemplate(order.connection_id, "pago_aprobado");
  if (!resuelta.ok) return;

  const total = Number(order.total);
  const components: Record<string, unknown>[] = [
    {
      type: "body",
      parameters: [
        { type: "text", text: order.public_order_number },
        { type: "text", text: formatearMonto(total) },
      ],
    },
  ];
  const indiceBotonUrl = findUrlButtonIndex(resuelta.template);
  let reviewLink: string | null = null;
  if (indiceBotonUrl >= 0) {
    const token = await createReviewToken(order.conversation_id);
    reviewLink = buildReviewLink(token);
    components.push({
      type: "button",
      sub_type: "url",
      index: String(indiceBotonUrl),
      parameters: [{ type: "text", text: token }],
    });
  }

  await sendTemplateMessage(
    resuelta.connection.credentials,
    resuelta.connection.externalId,
    canonicalToMetaRecipient(order.customer_external_id),
    "pago_aprobado",
    resuelta.template.language,
    components,
  );

  const texto = reviewLink
    ? `¡Tu pago del pedido #${order.public_order_number} por ${formatearMonto(total)} fue aprobado! 🎉 Contanos cómo fue tu experiencia: ${reviewLink}`
    : `¡Tu pago del pedido #${order.public_order_number} por ${formatearMonto(total)} fue aprobado! 🎉`;
  await appendMessage(order.conversation_id, "outbound", "agent", texto);
}

/** Plantilla "pago_rechazado" — sin botones, solo avisa que el pago no se pudo procesar. */
export async function notificarClientePagoRechazado(orderId: string): Promise<void> {
  const order = await fetchOrder(orderId);
  if (!order) return;

  const resuelta = await resolveApprovedTemplate(order.connection_id, "pago_rechazado");
  if (!resuelta.ok) return;

  await sendTemplateMessage(
    resuelta.connection.credentials,
    resuelta.connection.externalId,
    canonicalToMetaRecipient(order.customer_external_id),
    "pago_rechazado",
    resuelta.template.language,
    [
      {
        type: "body",
        parameters: [
          { type: "text", text: order.public_order_number },
          { type: "text", text: formatearMonto(Number(order.total)) },
        ],
      },
    ],
  );

  await appendMessage(
    order.conversation_id,
    "outbound",
    "agent",
    `Tu pago del pedido #${order.public_order_number} por ${formatearMonto(Number(order.total))} no pudo procesarse. Podés intentar de nuevo o elegir otro método.`,
  );
}
