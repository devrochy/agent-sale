import { canonicalToMetaRecipient } from "../../gateway/channels/meta/addresses.js";
import { resolveApprovedTemplate } from "../../gateway/channels/meta/resolveApprovedTemplate.js";
import { sendTemplateMessage } from "../../gateway/channels/meta/templates.js";
import { withTransaction } from "../../shared/db/index.js";
import { enviarPedidoConfirmado, type EnviarPedidoConfirmadoStatus } from "./enviarPedidoConfirmado.js";

export interface PedirConfirmacionDomicilioInput {
  order_id: string;
}

export type PedirConfirmacionDomicilioStatus =
  | "enviado"
  | "pedido_no_abierto"
  | "plantilla_no_aprobada"
  | "canal_no_soportado";

export interface PedirConfirmacionDomicilioOutput {
  order_id: string;
  status: PedirConfirmacionDomicilioStatus;
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

type EnviarConfirmarDomicilioResult =
  | { ok: true }
  | { ok: false; status: "plantilla_no_aprobada" | "canal_no_soportado" };

async function enviarPlantillaConfirmarDomicilio(order: OrderAddressRow): Promise<EnviarConfirmarDomicilioResult> {
  const resuelta = await resolveApprovedTemplate(order.connection_id, "confirmar_domicilio");
  if (!resuelta.ok) {
    return { ok: false, status: resuelta.status };
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
 * Tool pedir_confirmacion_domicilio — primer paso del cierre de un pedido
 * (ver docs/fase-3-whatsapp-gateway/plantillas-mensajes.md): manda la
 * plantilla "confirmar_domicilio", con sus 3 botones (Confirmar dirección /
 * Cambiar temporalmente / Cambiar permanentemente), y espera la respuesta
 * del cliente — recién cuando responde alguno de los 3 (ver
 * `confirmarDomicilioPedido`/`actualizarDireccionPedido` más abajo) se
 * manda el resumen "pedido_confirmado_v3" con sus propios botones
 * (Agregar productos / Cancelar pedido / Confirmar y pagar). Antes las
 * dos plantillas se mandaban juntas, en el mismo paso (era la tool
 * "cerrar_pedido") — separarlas evita que el cliente reciba 5 botones de
 * una sola vez repartidos en 2 mensajes.
 *
 * No cambia "orders.status": el pedido sigue "abierto" hasta que el
 * cliente decida. Puede volver a llamarse sin romper nada si hace falta
 * reenviar el pedido de confirmación (ej. el cliente no respondió).
 *
 * A propósito NO llama appendMessage — mismo motivo documentado en
 * `enviarPedidoConfirmado.ts`: correr en medio de la ejecución de la tool
 * rompería la secuencia tool_use→tool_result de la API del LLM.
 */
export async function pedirConfirmacionDomicilio(
  input: PedirConfirmacionDomicilioInput,
): Promise<PedirConfirmacionDomicilioOutput> {
  const order = await fetchOrderAddress(input.order_id);
  if (!order || order.status !== "abierto") {
    return { order_id: input.order_id, status: "pedido_no_abierto" };
  }

  const resultado = await enviarPlantillaConfirmarDomicilio(order);
  if (!resultado.ok) {
    return { order_id: input.order_id, status: resultado.status };
  }

  return { order_id: input.order_id, status: "enviado" };
}

export interface ConfirmarDomicilioPedidoInput {
  order_id: string;
}

export type ConfirmarDomicilioPedidoStatus = "confirmado" | "pedido_no_abierto";

export interface ConfirmarDomicilioPedidoOutput {
  order_id: string;
  status: ConfirmarDomicilioPedidoStatus;
  /** Ausente si `status` no es "confirmado" (no tiene sentido intentar mandar el resumen de un pedido que no se pudo confirmar). */
  pedido_confirmado_status?: EnviarPedidoConfirmadoStatus;
}

/**
 * Tool confirmar_domicilio_pedido — el otro lado de la plantilla
 * "confirmar_domicilio" que manda `pedirConfirmacionDomicilio`. Cuando el
 * cliente toca el botón "Confirmar dirección", el LLM la interpreta como
 * cualquier tap (llega como texto, ver inbound.ts) y llama esta tool con
 * el order_id de la conversación.
 *
 * `registrarGuia.ts` exige `address_confirmed_at IS NOT NULL` antes de
 * aceptar una guía — este es el único lugar (aparte del botón manual del
 * panel, ver adminPanel.ts) que lo pone en `now()`. El guard por
 * `status = 'abierto'` evita que una confirmación tardía pise algo en un
 * pedido que ya avanzó de estado por otro lado.
 *
 * `AND address_confirmed_at IS NULL` en el UPDATE es a propósito
 * (idempotencia): sin esto, un segundo tap al mismo botón "Confirmar
 * dirección" (doble tap del cliente, o un reintento del LLM) volvería a
 * mandar "pedido_confirmado_v3" una segunda vez.
 *
 * Manda "pedido_confirmado_v3" (ver enviarPedidoConfirmado.ts) apenas
 * queda confirmada la dirección — best-effort: si esa plantilla todavía
 * no está aprobada, no revierte la confirmación de domicilio (`status`
 * sigue "confirmado"), solo queda reflejado en `pedido_confirmado_status`.
 */
export async function confirmarDomicilioPedido(
  input: ConfirmarDomicilioPedidoInput,
): Promise<ConfirmarDomicilioPedidoOutput> {
  const confirmado = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE orders SET address_confirmed_at = now()
        WHERE id = $1 AND status = 'abierto' AND address_confirmed_at IS NULL`,
      [input.order_id],
    );
    return (result.rowCount ?? 0) > 0;
  });

  if (!confirmado) {
    return { order_id: input.order_id, status: "pedido_no_abierto" };
  }

  const { status: pedidoConfirmadoStatus } = await enviarPedidoConfirmado(input.order_id);
  return {
    order_id: input.order_id,
    status: "confirmado",
    pedido_confirmado_status: pedidoConfirmadoStatus,
  };
}

export type ReenviarConfirmacionDomicilioResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Botón "Reenviar confirmación" del panel (diálogo de guía, ver
 * adminPanel.ts) — para cuando el cliente nunca respondió al primer envío
 * de `pedirConfirmacionDomicilio`, o la plantilla recién se aprobó después
 * de intentarlo.
 */
export async function reenviarConfirmacionDomicilio(orderId: string): Promise<ReenviarConfirmacionDomicilioResult> {
  const order = await fetchOrderAddress(orderId);
  if (!order) {
    return { ok: false, error: "Pedido no encontrado." };
  }
  const resultado = await enviarPlantillaConfirmarDomicilio(order);
  if (!resultado.ok) {
    return {
      ok: false,
      error:
        resultado.status === "plantilla_no_aprobada"
          ? "La plantilla 'confirmar_domicilio' todavía no está aprobada por Meta."
          : "Esta conexión no admite plantillas de Meta.",
    };
  }
  return { ok: true };
}

/**
 * Válvula de escape del panel: el admin ya verificó la dirección por otro
 * medio (llamada, otro canal) y no quiere esperar a que el cliente
 * responda el botón — marca `address_confirmed_at` directo y manda
 * "pedido_confirmado_v3" (best-effort, mismo criterio que
 * `confirmarDomicilioPedido`: si falla, no revierte la confirmación). Se
 * audita con `adminUsername` en el motivo, mismo criterio que
 * `cancelarPedido` (adminPanel.ts) para las transiciones que alguien
 * puede preguntar "¿y esto por qué?" después.
 */
export async function confirmarDomicilioManual(orderId: string, adminUsername: string): Promise<boolean> {
  const confirmado = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE orders SET address_confirmed_at = now(), status_reason = $2
        WHERE id = $1 AND status = 'abierto' AND address_confirmed_at IS NULL`,
      [orderId, `Domicilio confirmado a mano por ${adminUsername}.`],
    );
    return (result.rowCount ?? 0) > 0;
  });

  if (confirmado) {
    await enviarPedidoConfirmado(orderId);
  }
  return confirmado;
}
