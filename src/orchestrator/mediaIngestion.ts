import { downloadMedia } from "../gateway/channels/meta/media.js";
import type { InboundMessage } from "../gateway/queue.js";
import { sendToConversation } from "../gateway/sendMessage.js";
import { buscarPedidoPendienteTransferencia, procesarComprobante } from "../domains/commerce/procesarComprobante.js";
import { describirImagenProducto } from "../domains/catalog/describirImagenProducto.js";
import { transcribirAudio } from "../media/transcribirAudio.js";
import { getCachedMediaResult, setCachedMediaResult } from "../shared/mediaResultCache.js";
import { getConnection } from "../shared/db/connectionsDirectory.js";
import { guardarMediaEntrante } from "../shared/db/inboundMediaDirectory.js";
import { getOpenAiConfig } from "../shared/db/settingsDirectory.js";
import { env } from "../config/env.js";
import { appendMessage, resolveConversation, type InboundOrigin } from "./memory.js";

type EntryLogger = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };

/**
 * Resultado del ruteo de un media entrante:
 * - `no_manejado`: no se pudo resolver la conexión de Meta para descargar
 *   el media (sin `connectionId` en el origin, o la conexión ya no existe)
 *   — con las 3 fases implementas, es el ÚNICO caso que llega acá;
 *   `consumer.ts` descarta el mensaje, igual que antes de esta feature.
 * - `procesado_completo`: ya se resolvió acá (comprobante aprobado/
 *   rechazado/escalado, o aviso de "no te entendí" cuando Whisper no pudo
 *   transcribir un audio o Claude no identificó ningún producto en una
 *   foto) — no debe pasar por el LLM.
 * - `continuar_como_texto`: el media se convirtió en texto (transcripción
 *   de un audio, o descripción de una foto de producto) y el turno debe
 *   seguir el camino normal del orquestador como si el cliente lo hubiera
 *   tipeado.
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
  // Contexto extra para el log (ej. `order_id` en el caso del comprobante)
  // — sin esto se perdía qué pedido quedaba afectado cuando no había
  // conexión para descargar su comprobante.
  contextoExtra: Record<string, unknown> = {},
) {
  if (!origin.connectionId) {
    entryLogger.warn(
      { event: eventoSinConexion, ...contextoExtra },
      "Llegó un media sin connectionId en el origin — no se puede descargar",
    );
    return null;
  }
  const connection = await getConnection(origin.connectionId);
  if (!connection) {
    entryLogger.warn(
      { event: eventoConexionNoEncontrada, connection_id: origin.connectionId, ...contextoExtra },
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

  // Determinístico: si hay un pedido esperando comprobante, la foto ES un
  // comprobante — no hace falta (ni conviene) preguntarle al cliente qué
  // es. Ver docblock del archivo: es un control financiero, no una
  // decisión del LLM.
  const pedido = await buscarPedidoPendienteTransferencia(customerId);

  const connection = await resolverConexion(
    origin,
    entryLogger,
    pedido ? "comprobante.sin_conexion" : "foto_producto.sin_conexion",
    pedido ? "comprobante.conexion_no_encontrada" : "foto_producto.conexion_no_encontrada",
    pedido ? { order_id: pedido.orderId } : {},
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

  if (pedido) {
    return procesarComoComprobante(pedido.orderId, inboundMediaId, media, conversationId, message.messageSid, entryLogger);
  }
  return procesarComoBusquedaDeProducto(inboundMediaId, media, conversationId, message.messageSid, entryLogger);
}

async function procesarComoComprobante(
  orderId: string,
  inboundMediaId: string,
  media: { buffer: Buffer; mimeType: string },
  conversationId: string,
  messageSid: string,
  entryLogger: EntryLogger,
): Promise<MediaResultado> {
  // Deja registro en la conversación aunque el LLM nunca la vea — para que
  // el panel muestre lo que pasó, igual que cualquier otro mensaje.
  await appendMessage(conversationId, "inbound", "customer", "[Imagen adjunta: comprobante de pago]");

  try {
    const resultado = await procesarComprobante({
      orderId,
      inboundMediaId,
      messageSid,
      buffer: media.buffer,
      mimeType: media.mimeType,
    });
    entryLogger.info(
      { event: "comprobante.procesado", order_id: orderId, resultado },
      "Comprobante de transferencia procesado",
    );
  } catch (error) {
    entryLogger.warn(
      { error, event: "comprobante.error_procesando", order_id: orderId },
      "Error procesando el comprobante — se reintentará vía dead-letter si sigue fallando",
    );
    throw error;
  }

  return { kind: "procesado_completo" };
}

/**
 * Búsqueda por foto de producto (Fase 3): no hay ninguna tool nueva ni
 * motor de similitud — la foto se convierte en una descripción de texto
 * (ver `describirImagenProducto.ts`) y esa descripción sigue el camino
 * normal del orquestador, como si el cliente la hubiera tipeado. El
 * prefijo "[Foto de producto]" le avisa al LLM que es una descripción
 * automática (imprecisa) y no las palabras textuales del cliente — el
 * bloque nuevo de `systemPrompt.ts` le dice qué hacer con eso (reintentar
 * más genérico si `consultar_inventario` no encuentra nada, nunca
 * responder "no tenemos" sin ofrecer una alternativa).
 */
async function procesarComoBusquedaDeProducto(
  inboundMediaId: string,
  media: { buffer: Buffer; mimeType: string },
  conversationId: string,
  messageSid: string,
  entryLogger: EntryLogger,
): Promise<MediaResultado> {
  let descripcion: string | null;
  try {
    // Misma cache de idempotencia por messageSid que el comprobante y el
    // audio: si un reintento de la cola repite este mensaje porque algo
    // DESPUÉS de describir la imagen falló, reusa el resultado en vez de
    // volver a pagar la llamada de visión.
    const cacheado = await getCachedMediaResult<string | null>(messageSid);
    if (cacheado) {
      descripcion = cacheado.value;
      entryLogger.info({ event: "foto_producto.descripcion_cacheada" }, "Reusando descripción ya generada (reintento)");
    } else {
      descripcion = await describirImagenProducto(media.buffer, media.mimeType);
      await setCachedMediaResult(messageSid, descripcion);
    }
  } catch (error) {
    entryLogger.warn(
      { error, event: "foto_producto.error_describiendo", inbound_media_id: inboundMediaId },
      "Error describiendo la foto de producto — se reintentará vía dead-letter si sigue fallando",
    );
    throw error;
  }

  if (!descripcion) {
    entryLogger.info(
      { event: "foto_producto.no_identificado", inbound_media_id: inboundMediaId },
      "No se pudo identificar ningún producto en la foto",
    );
    await appendMessage(conversationId, "inbound", "customer", "[Imagen adjunta: no se identificó un producto]");
    await sendToConversation(
      conversationId,
      "No pudimos reconocer bien qué buscás en esa foto 📷 ¿Nos contás qué producto es o mandás otra foto más de cerca?",
    );
    return { kind: "procesado_completo" };
  }

  entryLogger.info(
    { event: "foto_producto.descrita", inbound_media_id: inboundMediaId },
    "Foto de producto descrita, sigue el flujo normal como texto",
  );
  return { kind: "continuar_como_texto", texto: `[Foto de producto] El cliente mandó una foto. Descripción automática: ${descripcion}` };
}

async function procesarAudioEntrante(
  message: InboundMessage,
  origin: InboundOrigin,
  entryLogger: EntryLogger,
): Promise<MediaResultado> {
  // Mismo orden que procesarImagenEntrante (conversación primero, conexión
  // después) — antes era al revés acá, y un audio sin connectionId no
  // dejaba ningún rastro en customers/conversations, a diferencia del
  // mismo caso para una imagen.
  const { conversationId } = await resolveConversation(message.customerExternalId, message.customerName, origin);

  const connection = await resolverConexion(origin, entryLogger, "audio.sin_conexion", "audio.conexion_no_encontrada");
  if (!connection) {
    return { kind: "no_manejado" };
  }

  const media = await downloadMedia(connection.credentials, message.media!.mediaId);
  await guardarMediaEntrante({
    conversationId,
    kind: "audio",
    mimeType: media.mimeType,
    buffer: media.buffer,
  });

  let texto: string | null;
  try {
    // Cache de idempotencia por messageSid: si un reintento de la cola
    // repite este mismo mensaje porque algo DESPUÉS de transcribir falló,
    // reusa el resultado en vez de volver a pagar Whisper.
    const cacheado = await getCachedMediaResult<string | null>(message.messageSid);
    if (cacheado) {
      texto = cacheado.value;
      entryLogger.info({ event: "audio.transcripcion_cacheada" }, "Reusando transcripción ya hecha (reintento)");
    } else {
      // BYOK (panel) con fallback a env.openaiApiKey — ver comentario en
      // settingsDirectory.ts → getOpenAiConfig.
      const { apiKey } = await getOpenAiConfig();
      texto = await transcribirAudio(media.buffer, media.mimeType, apiKey || env.openaiApiKey);
      await setCachedMediaResult(message.messageSid, texto);
    }
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
