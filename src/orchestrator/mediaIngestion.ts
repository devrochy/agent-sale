import { downloadMedia } from "../gateway/channels/meta/media.js";
import type { InboundMessage } from "../gateway/queue.js";
import { buscarPedidoPendienteTransferencia, procesarComprobante } from "../domains/commerce/procesarComprobante.js";
import { getConnection } from "../shared/db/connectionsDirectory.js";
import { guardarMediaEntrante } from "../shared/db/inboundMediaDirectory.js";
import { appendMessage, resolveConversation, type InboundOrigin } from "./memory.js";

/**
 * Ruteo determinístico de medios entrantes (ver docs del plan "medios
 * entrantes"). Vive separado de `orchestrator/consumer.ts` porque no
 * comparte nada con el resto del procesamiento de un turno — es
 * financiero/de auditoría, no conversacional, y no debe pasar por el LLM.
 *
 * Hoy solo maneja el caso implementado (Fase 1: comprobante de
 * transferencia). Audio (Fase 2) y foto de producto — una imagen que NO es
 * un comprobante (Fase 3) — todavía no tienen destino: se descartan igual
 * que antes de esta feature (ver `inbound.ts`, que ya no las tira en el
 * parseo, así que el descarte ahora vive acá). Devuelve `false` en esos
 * casos para que `consumer.ts` haga exactamente ese descarte.
 */
export async function procesarMediaEntrante(
  message: InboundMessage,
  origin: InboundOrigin,
  entryLogger: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void },
): Promise<boolean> {
  if (message.media?.type !== "image") {
    // Audio: Fase 2 (transcripción) todavía no implementada.
    return false;
  }

  const { customerId, conversationId } = await resolveConversation(
    message.customerExternalId,
    message.customerName,
    origin,
  );

  const pedido = await buscarPedidoPendienteTransferencia(customerId);
  if (!pedido) {
    // No hay un pedido por transferencia esperando pago — no es un
    // comprobante. Búsqueda por foto de producto: Fase 3 todavía no
    // implementada.
    return false;
  }

  if (!origin.connectionId) {
    entryLogger.warn(
      { event: "comprobante.sin_conexion", order_id: pedido.orderId },
      "Llegó una posible imagen de comprobante sin connectionId en el origin — no se puede descargar",
    );
    return false;
  }
  const connection = await getConnection(origin.connectionId);
  if (!connection) {
    entryLogger.warn(
      { event: "comprobante.conexion_no_encontrada", connection_id: origin.connectionId },
      "La conexión del mensaje ya no existe — no se puede descargar el comprobante",
    );
    return false;
  }

  const media = await downloadMedia(connection.credentials, message.media.mediaId);
  const inboundMediaId = await guardarMediaEntrante({
    conversationId,
    kind: "image",
    mimeType: media.mimeType,
    buffer: media.buffer,
  });

  // Deja registro en la conversación aunque el LLM nunca la vea — para que
  // el panel muestre lo que pasó, igual que cualquier otro mensaje.
  await appendMessage(conversationId, "inbound", "customer", "[Imagen adjunta: comprobante de pago]");

  try {
    const resultado = await procesarComprobante({
      orderId: pedido.orderId,
      inboundMediaId,
      messageSid: message.messageSid,
      buffer: media.buffer,
      mimeType: media.mimeType,
    });
    entryLogger.info(
      { event: "comprobante.procesado", order_id: pedido.orderId, resultado },
      "Comprobante de transferencia procesado",
    );
  } catch (error) {
    entryLogger.warn(
      { error, event: "comprobante.error_procesando", order_id: pedido.orderId },
      "Error procesando el comprobante — se reintentará vía dead-letter si sigue fallando",
    );
    throw error;
  }

  return true;
}
