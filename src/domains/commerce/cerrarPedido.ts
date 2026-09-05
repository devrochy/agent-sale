import { getConnection, withTransaction } from "../../shared/db/index.js";
import { listTemplates } from "../../shared/db/whatsappTemplatesDirectory.js";
import { canonicalToMetaRecipient } from "../../gateway/channels/meta/addresses.js";
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
  public_order_number: string;
  delivery_full_name: string | null;
  customer_full_name: string | null;
  customer_external_id: string;
  connection_id: string | null;
}

/**
 * Tool cerrar_pedido — punto de cierre del pedido que pidió el usuario:
 * en vez de que el propio LLM redacte el resumen final y la pregunta de
 * "¿confirmás?", se manda la plantilla aprobada "pedido_confirmado" con
 * sus 3 botones (Agregar productos / Cancelar pedido / Confirmar y pagar,
 * ver adminPanel.ts -> buildButtonsComponent) y se espera la respuesta del
 * cliente como un mensaje más — el LLM la interpreta en el turno
 * siguiente igual que cualquier texto, sin un enrutador aparte (dos de
 * los tres caminos ya tienen tool: "agregar_item_pedido" y
 * "cancelar_pedido"; el tercero es el botón URL, que no vuelve a pasar
 * por el LLM).
 *
 * No cambia "orders.status": el pedido sigue "abierto" hasta que el
 * cliente decida — cerrar_pedido es un mensaje, no una transición de
 * estado. Puede volver a llamarse sin romper nada si hace falta reenviar
 * el resumen (ej. el cliente no respondió).
 *
 * A propósito NO llama appendMessage para dejar registro del texto
 * plantilla (a diferencia de lo que podría parecer razonable, y a
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
 * llegan como texto propio ("Agregar productos", "Cancelar pedido") que
 * se interpreta solo, sin depender de este mensaje.
 */
export async function cerrarPedido(input: CerrarPedidoInput): Promise<CerrarPedidoOutput> {
  const order = await withTransaction(async (client) => {
    const result = await client.query<OrderRow>(
      `SELECT o.status, o.conversation_id, o.total, o.delivery_method, o.public_order_number,
              o.delivery_full_name, c.full_name AS customer_full_name,
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

  if (!order.connection_id) {
    return { order_id: input.order_id, status: "canal_no_soportado" };
  }
  const connection = await getConnection(order.connection_id);
  // Las plantillas de Meta solo aplican a WhatsApp Cloud API — Twilio
  // gestiona sus propias plantillas por fuera de este proyecto (ver el
  // docblock de gateway/channels/meta/templates.ts), y ni Instagram ni
  // Messenger tienen plantillas en absoluto.
  if (!connection || connection.provider !== "meta" || connection.channel !== "whatsapp") {
    return {
      order_id: input.order_id,
      status: "canal_no_soportado",
      public_order_number: order.public_order_number,
    };
  }

  const plantillasAprobadas = (await listTemplates(connection.id)).filter(
    (t) => t.name === "pedido_confirmado" && t.status === "approved",
  );
  const plantilla = plantillasAprobadas[0];
  if (!plantilla) {
    return {
      order_id: input.order_id,
      status: "plantilla_no_aprobada",
      public_order_number: order.public_order_number,
    };
  }

  const fullName = order.delivery_full_name || order.customer_full_name || "cliente";
  const total = Number(order.total);
  const deliveryLabel = DELIVERY_METHOD_LABEL[order.delivery_method] ?? order.delivery_method;

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
  // El botón "Confirmar y pagar" (URL con sufijo dinámico, ver
  // buildButtonsComponent) va siempre en el último índice del arreglo de
  // botones — es el único con variable, así que su índice es
  // `buttons.length - 1` sin necesidad de buscarlo por texto.
  const botones = (plantilla.components.find((c) => c.type === "BUTTONS") as
    | { buttons?: { type?: string }[] }
    | undefined)?.buttons;
  const indiceBotonUrl = botones?.findIndex((b) => b.type === "URL") ?? -1;
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
    canonicalToMetaRecipient(order.customer_external_id),
    "pedido_confirmado",
    plantilla.language,
    components,
  );

  return {
    order_id: input.order_id,
    status: "enviado",
    public_order_number: order.public_order_number,
  };
}
