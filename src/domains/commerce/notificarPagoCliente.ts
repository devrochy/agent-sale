import { appendMessage } from "../../orchestrator/memory.js";
import { sendSurveyOnClose } from "../../orchestrator/satisfactionSurvey.js";
import { withTransaction } from "../../shared/db/index.js";
import { canonicalToMetaRecipient } from "../../gateway/channels/meta/addresses.js";
import {
  findUrlButtonIndex,
  resolveApprovedTemplate,
  type ResolveApprovedTemplateResult,
} from "../../gateway/channels/meta/resolveApprovedTemplate.js";
import { sendTemplateMessage } from "../../gateway/channels/meta/templates.js";

/**
 * Notificaciones al CLIENTE del resultado de su pago — a diferencia de
 * `notificarAdmins` en wompiWebhookHandler.ts (que ya existía y sigue
 * avisándole al negocio), estas dos funciones son las que le llegan al
 * comprador. Corren siempre disparadas desde el webhook de Wompi, nunca
 * desde dentro de una tool del LLM — por eso, a diferencia de
 * enviarPedidoConfirmado.ts, SÍ pueden usar appendMessage: no hay ningún tool_use en
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

/**
 * Plantilla "pago_aprobado" — el botón "Dejar reseña" quedó apuntando a
 * un dominio de túnel Cloudflare efímero desde que se aprobó (roto en
 * producción). Meta no permite editar una plantilla aprobada, y borrar y
 * recrear con el MISMO nombre bloquea el nombre por semanas (ver
 * scripts/recrear-plantilla-pago-aprobado.ts) — la solución real es
 * "pago_aprobado_v2", sin ese botón: la reseña ya no depende de ningún
 * botón/dominio fijo, se unificó con la encuesta de satisfacción 1-5
 * (orchestrator/satisfactionSurvey.ts) que genera el link real en el
 * momento, como texto libre.
 *
 * Mientras "pago_aprobado_v2" no esté aprobada por Meta (puede tardar
 * días), se sigue usando la vieja "pago_aprobado" como respaldo — sin
 * este fallback, un pedido pagado se quedaría sin ningún aviso de "pago
 * aprobado" durante ese lapso, que es peor que el botón roto que ya
 * tiene hoy. El botón de la vieja sigue apuntando al dominio muerto (eso
 * no tiene arreglo sin la v2), pero el aviso y la encuesta con el link
 * real de reseña sí llegan igual.
 */
async function resolverPlantillaPagoAprobado(
  connectionId: string | null,
): Promise<{ resuelta: ResolveApprovedTemplateResult; esVersionSinBoton: boolean }> {
  const v2 = await resolveApprovedTemplate(connectionId, "pago_aprobado_v2");
  if (v2.ok) {
    return { resuelta: v2, esVersionSinBoton: true };
  }
  const original = await resolveApprovedTemplate(connectionId, "pago_aprobado");
  return { resuelta: original, esVersionSinBoton: false };
}

export async function notificarClientePagoAprobado(orderId: string): Promise<void> {
  const order = await fetchOrder(orderId);
  if (!order) return;

  const { resuelta, esVersionSinBoton } = await resolverPlantillaPagoAprobado(order.connection_id);
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
  if (!esVersionSinBoton) {
    // Respaldo sobre la plantilla vieja: el botón sigue ahí (Meta exige
    // un parámetro por cada componente declarado), pero ya no apunta a
    // un token de reseña real — el dominio está muerto de todos modos.
    const indiceBotonUrl = findUrlButtonIndex(resuelta.template);
    if (indiceBotonUrl >= 0) {
      components.push({
        type: "button",
        sub_type: "url",
        index: String(indiceBotonUrl),
        parameters: [{ type: "text", text: order.public_order_number }],
      });
    }
  }

  await sendTemplateMessage(
    resuelta.connection.credentials,
    resuelta.connection.externalId,
    canonicalToMetaRecipient(order.customer_external_id),
    resuelta.template.name,
    resuelta.template.language,
    components,
  );

  const texto = `¡Tu pago del pedido #${order.public_order_number} por ${formatearMonto(total)} fue aprobado! 🎉`;
  await appendMessage(order.conversation_id, "outbound", "agent", texto);

  await sendSurveyOnClose(order.conversation_id);
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
