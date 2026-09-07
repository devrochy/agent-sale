import { withTransaction } from "../../shared/db/index.js";
import { canonicalToMetaRecipient } from "../../gateway/channels/meta/addresses.js";
import {
  findUrlButtonIndex,
  resolveApprovedTemplate,
} from "../../gateway/channels/meta/resolveApprovedTemplate.js";
import { sendTemplateMessage } from "../../gateway/channels/meta/templates.js";

export interface CerrarPedidoInput {
  order_id: string;
}

export type CerrarPedidoStatus =
  | "enviado"
  | "pedido_no_abierto"
  | "plantilla_no_aprobada"
  | "canal_no_soportado";

export interface CerrarPedidoOutput {
  order_id: string;
  status: CerrarPedidoStatus;
  public_order_number?: string;
  /**
   * Estado del segundo mensaje (confirmación de domicilio, ver
   * confirmarDomicilioPedido.ts) — independiente del de arriba: si
   * "pedido_confirmado_v2" se manda bien pero "confirmar_domicilio" todavía no
   * está aprobada, el cierre del pedido no se considera fallido (el LLM ya
   * cerró la venta; el aviso de domicilio es un segundo mensaje aparte).
   * Ausente si el primer envío ya falló (no tiene sentido intentar el
   * segundo sin conexión/plantilla resuelta).
   */
  domicilio_status?: "enviado" | "plantilla_no_aprobada";
}

const DELIVERY_METHOD_LABEL: Record<string, string> = {
  domicilio: "Domicilio",
  recoger_en_tienda: "Recoger en tienda",
};

function formatearMonto(total: number): string {
  return `$${total.toLocaleString("es-CO")}`;
}

interface OrderRow {
  status: string;
  conversation_id: string;
  total: string;
  delivery_method: string;
  delivery_address: string | null;
  public_order_number: string;
  delivery_full_name: string | null;
  customer_full_name: string | null;
  customer_external_id: string;
  connection_id: string | null;
}

/**
 * Tool cerrar_pedido — punto de cierre del pedido que pidió el usuario:
 * en vez de que el propio LLM redacte el resumen final y la pregunta de
 * "¿confirmás?", se manda la plantilla aprobada "pedido_confirmado_v2" con
 * sus 3 botones (Agregar productos / Cancelar pedido / Confirmar y pagar,
 * los 3 Quick Reply — ver adminPanel.ts -> buildButtonsComponent) y se
 * espera la respuesta del cliente como un mensaje más — el LLM la interpreta en el turno
 * siguiente igual que cualquier texto, sin un enrutador aparte (dos de
 * los tres caminos ya tienen tool: "agregar_item_pedido" y
 * "cancelar_pedido"; el tercero es el botón URL, que no vuelve a pasar
 * por el LLM).
 *
 * Manda un SEGUNDO mensaje de plantilla, "confirmar_domicilio" (ver
 * confirmarDomicilioPedido.ts y registrarGuia.ts, que exige esta
 * confirmación antes de aceptar una guía) — best-effort: si esa plantilla
 * todavía no está aprobada, no revierte ni falla el cierre del pedido
 * (`status` sigue "enviado"), solo queda reflejado en
 * `domicilio_status`. El admin puede reenviarla después desde el panel.
 *
 * No cambia "orders.status": el pedido sigue "abierto" hasta que el
 * cliente decida — cerrar_pedido es un mensaje, no una transición de
 * estado. Puede volver a llamarse sin romper nada si hace falta reenviar
 * el resumen (ej. el cliente no respondió).
 *
 * A propósito NO llama appendMessage para dejar registro de ninguno de los
 * dos textos (a diferencia de lo que podría parecer razonable, y a
 * diferencia — en apariencia — de datosTransferencia.ts, que sí lo evita
 * por otro motivo): esta función corre *en medio* de la ejecución de la
 * tool, antes de que loop.ts/toolExecutor.ts agreguen el tool_result de
 * este mismo tool_use. Un appendMessage acá insertaría una fila entre el
 * mensaje del asistente (con el tool_use) y su tool_result — rompiendo la
 * regla estricta de la API (Anthropic/OpenAI-compatible) de que un
 * tool_use tiene que ir seguido inmediatamente por su tool_result, sin
 * mensajes de por medio. Se probó en vivo (2026-09-03): deja la
 * conversación completa inutilizable, todo turno futuro falla con 400
 * "insufficient tool messages following tool_calls message" hasta reparar
 * la fila a mano. El LLM no necesita el texto igual: los taps de botón
 * llegan como texto propio ("Agregar productos", "Cancelar pedido",
 * "Confirmar dirección") que se interpreta solo, sin depender de este
 * mensaje.
 */
export async function cerrarPedido(input: CerrarPedidoInput): Promise<CerrarPedidoOutput> {
  const order = await withTransaction(async (client) => {
    const result = await client.query<OrderRow>(
      `SELECT o.status, o.conversation_id, o.total, o.delivery_method, o.delivery_address,
              o.public_order_number, o.delivery_full_name, c.full_name AS customer_full_name,
              c.external_id AS customer_external_id, conv.connection_id
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         JOIN conversations conv ON conv.id = o.conversation_id
        WHERE o.id = $1`,
      [input.order_id],
    );
    return result.rows[0] ?? null;
  });

  if (!order || order.status !== "abierto") {
    return { order_id: input.order_id, status: "pedido_no_abierto" };
  }

  // "pedido_confirmado" a secas quedó bloqueada por Meta (borrada y recreada
  // el 2026-09-06 con el botón "Confirmar y pagar" nuevo — Meta no deja
  // reusar el nombre por 4 semanas tras un borrado). "_v2" es la plantilla
  // real desde entonces, ver docs/fase-3-whatsapp-gateway/plantillas-mensajes.md.
  const pedidoConfirmado = await resolveApprovedTemplate(order.connection_id, "pedido_confirmado_v2");
  if (!pedidoConfirmado.ok) {
    return {
      order_id: input.order_id,
      status: pedidoConfirmado.status,
      public_order_number: order.public_order_number,
    };
  }
  const { connection, template: plantilla } = pedidoConfirmado;

  const fullName = order.delivery_full_name || order.customer_full_name || "cliente";
  const total = Number(order.total);
  const deliveryLabel = DELIVERY_METHOD_LABEL[order.delivery_method] ?? order.delivery_method;
  const destinatario = canonicalToMetaRecipient(order.customer_external_id);

  const components: Record<string, unknown>[] = [
    {
      type: "body",
      parameters: [
        { type: "text", text: fullName },
        { type: "text", text: order.public_order_number },
        { type: "text", text: formatearMonto(total) },
        { type: "text", text: deliveryLabel },
      ],
    },
  ];
  // "Confirmar y pagar" era un botón URL con sufijo dinámico; desde
  // 2026-09-06 es un Quick Reply (resuelto por la tool confirmar_pago_pedido,
  // ver confirmarPagoPedido.ts) — findUrlButtonIndex simplemente no
  // encuentra ningún botón URL en la plantilla nueva y esto se salta solo.
  // Se deja el chequeo por si en el futuro alguna otra plantilla vuelve a
  // tener un botón URL con variable.
  const indiceBotonUrl = findUrlButtonIndex(plantilla);
  if (indiceBotonUrl >= 0) {
    components.push({
      type: "button",
      sub_type: "url",
      index: String(indiceBotonUrl),
      // El `order_id` real (no el número público, que es secuencial y
      // adivinable) — es lo que una futura página de pago necesitaría
      // para resolver el pedido sin exponer un id fácil de recorrer.
      parameters: [{ type: "text", text: input.order_id }],
    });
  }

  await sendTemplateMessage(
    connection.credentials,
    connection.externalId,
    destinatario,
    "pedido_confirmado_v2",
    plantilla.language,
    components,
  );

  const domicilio = await resolveApprovedTemplate(order.connection_id, "confirmar_domicilio");
  let domicilioStatus: CerrarPedidoOutput["domicilio_status"] = "plantilla_no_aprobada";
  if (domicilio.ok) {
    await sendTemplateMessage(
      domicilio.connection.credentials,
      domicilio.connection.externalId,
      destinatario,
      "confirmar_domicilio",
      domicilio.template.language,
      [
        {
          type: "body",
          parameters: [
            { type: "text", text: order.public_order_number },
            { type: "text", text: order.delivery_address ?? deliveryLabel },
          ],
        },
      ],
    );
    domicilioStatus = "enviado";
  }

  return {
    order_id: input.order_id,
    status: "enviado",
    public_order_number: order.public_order_number,
    domicilio_status: domicilioStatus,
  };
}
