import { withTransaction } from "../../shared/db/index.js";
import { canonicalToMetaRecipient } from "../../gateway/channels/meta/addresses.js";
import {
  findUrlButtonIndex,
  resolveApprovedTemplate,
} from "../../gateway/channels/meta/resolveApprovedTemplate.js";
import { sendTemplateMessage } from "../../gateway/channels/meta/templates.js";

export type EnviarPedidoConfirmadoStatus = "enviado" | "pedido_no_encontrado" | "plantilla_no_aprobada" | "canal_no_soportado";

export interface EnviarPedidoConfirmadoResult {
  status: EnviarPedidoConfirmadoStatus;
}

const DELIVERY_METHOD_LABEL: Record<string, string> = {
  domicilio: "Domicilio",
  recoger_en_tienda: "Recoger en tienda",
};

function formatearMonto(total: number): string {
  return `$${total.toLocaleString("es-CO")}`;
}

interface OrderRow {
  total: string;
  delivery_method: string;
  public_order_number: string;
  delivery_full_name: string | null;
  customer_full_name: string | null;
  customer_external_id: string;
  connection_id: string | null;
}

/**
 * Manda la plantilla "pedido_confirmado_v3" (resumen del pedido con sus 3
 * botones: Agregar productos / Cancelar pedido / Confirmar y pagar) — en
 * vez de que el LLM redacte el resumen final, se le manda esta plantilla
 * con los datos ya armados (ver adminPanel.ts -> buildButtonsComponent).
 *
 * Extraído de lo que antes era la tool "cerrar_pedido" (ver
 * docs/fase-3-whatsapp-gateway/plantillas-mensajes.md): ahora este envío
 * pasa a ser el ÚLTIMO paso del flujo de domicilio, no el primero — se
 * llama desde `confirmarDomicilioPedido`, `actualizarDireccionPedido` y
 * `confirmarDomicilioManual` (panel), justo después de que la dirección
 * queda confirmada por cualquiera de esos 3 caminos. Antes se mandaba
 * junto con "confirmar_domicilio" en el mismo paso; ahora "confirmar_domicilio"
 * se manda primero (ver `pedirConfirmacionDomicilio` en
 * confirmarDomicilioPedido.ts) y recién cuando el cliente responde eso
 * llega este resumen.
 *
 * No cambia "orders.status": sigue "abierto" hasta que el cliente decida.
 *
 * A propósito NO llama appendMessage — mismo motivo que tenía la tool
 * "cerrar_pedido" original: cuando esta función corre en medio de la
 * ejecución de una tool (confirmar_domicilio_pedido, actualizar_direccion_pedido),
 * un appendMessage acá insertaría una fila entre el mensaje del asistente
 * (con el tool_use) y su tool_result, rompiendo la secuencia estricta que
 * exige la API del LLM (ver el mismo detalle, probado en vivo el
 * 2026-09-03, documentado antes en cerrarPedido.ts). El LLM no necesita
 * el texto igual: los taps de botón llegan como texto propio ("Agregar
 * productos", "Cancelar pedido", "Confirmar y pagar") que se interpreta
 * solo, sin depender de este mensaje.
 */
export async function enviarPedidoConfirmado(orderId: string): Promise<EnviarPedidoConfirmadoResult> {
  const order = await withTransaction(async (client) => {
    const result = await client.query<OrderRow>(
      `SELECT o.total, o.delivery_method, o.public_order_number, o.delivery_full_name,
              c.full_name AS customer_full_name, c.external_id AS customer_external_id, conv.connection_id
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         JOIN conversations conv ON conv.id = o.conversation_id
        WHERE o.id = $1`,
      [orderId],
    );
    return result.rows[0] ?? null;
  });

  if (!order) {
    return { status: "pedido_no_encontrado" };
  }

  // "pedido_confirmado" (y luego "_v2") quedaron bloqueadas por Meta al
  // intentar borrar+recrear con el botón "Confirmar y pagar" nuevo el
  // 2026-09-06 — Meta no deja reusar el nombre de una plantilla borrada por
  // un tiempo que su propio mensaje de error no refleja bien (dijo "4 weeks"
  // la primera vez, "less than 1 minute" la segunda, y siguió bloqueada 5+
  // minutos). "_v3" es la plantilla real desde entonces, ver
  // docs/fase-3-whatsapp-gateway/plantillas-mensajes.md.
  const pedidoConfirmado = await resolveApprovedTemplate(order.connection_id, "pedido_confirmado_v3");
  if (!pedidoConfirmado.ok) {
    return { status: pedidoConfirmado.status };
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
      parameters: [{ type: "text", text: orderId }],
    });
  }

  await sendTemplateMessage(
    connection.credentials,
    connection.externalId,
    destinatario,
    "pedido_confirmado_v3",
    plantilla.language,
    components,
  );

  return { status: "enviado" };
}
