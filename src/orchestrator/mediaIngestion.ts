import { downloadMedia } from "../gateway/channels/meta/media.js";
import type { InboundMessage } from "../gateway/queue.js";
import { sendToConversation } from "../gateway/sendMessage.js";
import { buscarPedidoPendienteTransferencia, procesarComprobante } from "../domains/commerce/procesarComprobante.js";
import { transcribirAudio } from "../media/transcribirAudio.js";
import { getConnection } from "../shared/db/connectionsDirectory.js";
import { guardarMediaEntrante } from "../shared/db/inboundMediaDirectory.js";
import { appendMessage, resolveConversation, type InboundOrigin } from "./memory.js";

type EntryLogger = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };

/**
 * Resultado del ruteo de un media entrante:
 * - `no_manejado`: nada implementado para este caso todavía (imagen que no
 *   es un comprobante — Fase 3 — o un audio que Whisper no pudo entender).
 *   `consumer.ts` descarta el mensaje, igual que antes de esta feature.
 * - `procesado_completo`: ya se resolvió acá (comprobante aprobado/
 *   rechazado/escalado, o aviso de "no te entendí" en un audio) — no debe
 *   pasar por el LLM.
 * - `continuar_como_texto`: el media se convirtió en texto (transcripción
 *   de un audio) y el turno debe seguir el camino normal del orquestador
 *   como si el cliente lo hubiera tipeado.
 */
export type MediaResultado =
  | { kind: "no_manejado" }
  | { kind: "procesado_completo" }
  | { kind: "continuar_como_texto"; texto: string };

/**
 * Ruteo determinístico de medios entrantes (ver docs del plan "medios
 * entrantes"). Vive separado de `orchestrator/consumer.ts` porque las
 * decisiones de acá (comprobante de pago, transcripción) son
 * financieras/de auditoría o mecánicas, no conversacionales, y varias no
 * deben pasar por el LLM en absoluto.
 */
export async function procesarMediaEntrante(
  message: InboundMessage,
  origin: InboundOrigin,
  entryLogger: EntryLogger,
): Promise<MediaResultado> {
  if (!message.media) {
    return { kind: "no_manejado" };
  }

  if (message.media.type === "audio") {
    return procesarAudioEntrante(message, origin, entryLogger);
  }

  return procesarImagenEntrante(message, origin, entryLogger);
}

async function resolverConexion(
  origin: InboundOrigin,
  entryLogger: EntryLogger,
  eventoSinConexion: string,
  eventoConexionNoEncontrada: string,
) {
  if (!origin.connectionId) {
    entryLogger.warn(
      { event: eventoSinConexion },
      "Llegó un media sin connectionId en el origin — no se puede descargar",
    );
    return null;
  }
  const connection = await getConnection(origin.connectionId);
  if (!connection) {
    entryLogger.warn(
      { event: eventoConexionNoEncontrada, connection_id: origin.connectionId },
      "La conexión del mensaje ya no existe — no se puede descargar el media",
    );
    return null;
  }
  return connection;
}

async function procesarImagenEntrante(
  message: InboundMessage,
  origin: InboundOrigin,
  entryLogger: EntryLogger,
): Promise<MediaResultado> {
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
    return { kind: "no_manejado" };
  }

  const connection = await resolverConexion(
    origin,
    entryLogger,
    "comprobante.sin_conexion",
    "comprobante.conexion_no_encontrada",
  );
  if (!connection) {
    return { kind: "no_manejado" };
  }

  const media = await downloadMedia(connection.credentials, message.media!.mediaId);
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

  return { kind: "procesado_completo" };
}

async function procesarAudioEntrante(
  message: InboundMessage,
  origin: InboundOrigin,
  entryLogger: EntryLogger,
): Promise<MediaResultado> {
  const connection = await resolverConexion(origin, entryLogger, "audio.sin_conexion", "audio.conexion_no_encontrada");
  if (!connection) {
    return { kind: "no_manejado" };
  }

  const { conversationId } = await resolveConversation(message.customerExternalId, message.customerName, origin);

  const media = await downloadMedia(connection.credentials, message.media!.mediaId);
  await guardarMediaEntrante({
    conversationId,
    kind: "audio",
    mimeType: media.mimeType,
    buffer: media.buffer,
  });

  let texto: string | null;
  try {
    texto = await transcribirAudio(media.buffer, media.mimeType);
  } catch (error) {
    entryLogger.warn(
      { error, event: "audio.error_transcribiendo" },
      "Error transcribiendo el audio — se reintentará vía dead-letter si sigue fallando",
    );
    throw error;
  }

  if (!texto) {
    entryLogger.info({ event: "audio.ilegible" }, "Whisper no pudo transcribir nada en claro");
    await appendMessage(conversationId, "inbound", "customer", "[Audio adjunto: no se pudo transcribir]");
    await sendToConversation(
      conversationId,
      "No pudimos entender el audio 🎙️ ¿Podés escribirlo o mandarlo de nuevo, más despacio y sin ruido de fondo?",
    );
    return { kind: "procesado_completo" };
  }

  entryLogger.info({ event: "audio.transcrito" }, "Audio transcripto, sigue el flujo normal como texto");
  return { kind: "continuar_como_texto", texto };
}
