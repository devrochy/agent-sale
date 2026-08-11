import type { Logger } from "pino";
import { splitForBubbles } from "../gateway/messageSplitter.js";
import { sendToConversation } from "../gateway/sendMessage.js";
import { getBehaviorConfig } from "../shared/db/settingsDirectory.js";
import { resolveBehaviorConfig } from "./behaviorConfig.js";
import type { TurnResult } from "./loop.js";

// Estilo de mensajes (Fase 11.4 extendida, ver ADR-021): reintento chico
// del envío de UNA burbuja puntual — nunca del turno completo, eso
// dispararía una respuesta NUEVA del LLM.
const BUBBLE_SEND_ATTEMPTS = 2;
const BUBBLE_SEND_DELAY_MS = 700;

/**
 * Envía el resultado de un turno como una o varias burbujas de WhatsApp,
 * según el estilo de mensajes configurado. Compartido entre `consumer.ts`
 * (turno inmediato) y `debounceScheduler.ts` (turno diferido, ver
 * ADR-022) — el envío es idéntico en ambos casos, solo cambia de dónde
 * viene el `TurnResult`.
 *
 * `receivedAt` es opcional: en el camino inmediato hay un único mensaje
 * que disparó el turno y tiene sentido medir latencia total desde que
 * llegó; en el camino diferido (debounce) no hay un "recibido" único
 * claro (pueden ser varios mensajes acumulados), así que ese caller no lo
 * pasa y el campo simplemente no se loguea.
 *
 * Recibe `conversationId` y no el teléfono (Fase 19): la respuesta tiene que
 * salir por la misma conexión por la que el cliente escribió. Este es el
 * camino caliente de cada turno y el único con reintentos, así que responder
 * por la conexión equivocada acá se multiplicaría por cada burbuja.
 */
export async function sendTurnBubbles(
  conversationId: string,
  result: TurnResult,
  entryLogger: Logger,
  receivedAt?: number,
): Promise<void> {
  if (result.responseText === null) {
    entryLogger.info(
      { event: "orchestrator.conversacion_escalada" },
      "Conversación ya escalada, sin respuesta automática",
    );
    return;
  }

  entryLogger.info(
    { event: "orchestrator.respuesta_lista" },
    "Respuesta lista, enviando por el canal de la conversación",
  );
  const behaviorConfig = resolveBehaviorConfig(await getBehaviorConfig());
  const bubbles = splitForBubbles(result.responseText, behaviorConfig.estiloMensajes);

  let lostCount = 0;
  for (let index = 0; index < bubbles.length; index++) {
    const isLast = index === bubbles.length - 1;
    let sent = false;
    let lastError: unknown;
    for (let attempt = 1; attempt <= BUBBLE_SEND_ATTEMPTS && !sent; attempt++) {
      try {
        await sendToConversation(
          conversationId,
          bubbles[index]!,
          isLast ? (result.mediaUrl ?? undefined) : undefined,
        );
        sent = true;
      } catch (error) {
        lastError = error;
        // La clave tiene que ser `err`: es la que pino serializa con su
        // serializer de errores. Con cualquier otro nombre un Error sale como
        // `{}` (sus propiedades no son enumerables) y el log queda diciendo
        // que falló sin decir por qué — que es justamente lo que hace falta
        // para distinguir un rechazo por ventana de 24h vencida de una
        // credencial mala.
        entryLogger.warn(
          { event: "gateway.envio_burbuja_fallido", index, attempt, err: error },
          "Fallo al enviar una burbuja, reintentando",
        );
      }
    }
    if (!sent) {
      lostCount++;
      entryLogger.error(
        { event: "gateway.envio_burbuja_perdido", index, err: lastError },
        "No se pudo enviar una burbuja tras reintentos — se continúa con las siguientes",
      );
    }
    if (!isLast) {
      await new Promise((resolve) => setTimeout(resolve, BUBBLE_SEND_DELAY_MS));
    }
  }

  const totalLatencyMs =
    receivedAt !== undefined && !Number.isNaN(receivedAt) ? Date.now() - receivedAt : undefined;

  // El evento de confirmación es condicional a propósito. Emitirlo siempre
  // hacía que un turno con las burbujas perdidas terminara con un renglón que
  // dice que el proveedor lo aceptó: en Grafana se lee como entrega exitosa y
  // tapa el fallo que los renglones anteriores ya habían reportado.
  if (lostCount > 0) {
    entryLogger.error(
      {
        event: "gateway.envio_incompleto",
        total_latency_ms: totalLatencyMs,
        bubble_count: bubbles.length,
        bubbles_lost: lostCount,
      },
      "El turno se envió incompleto — el cliente no recibió la respuesta entera",
    );
    return;
  }

  entryLogger.info(
    {
      event: "gateway.confirmacion_envio",
      total_latency_ms: totalLatencyMs,
      bubble_count: bubbles.length,
    },
    "Mensaje enviado y confirmado por el proveedor del canal",
  );
}
