import type { Logger } from "pino";
import { splitForBubbles } from "../gateway/messageSplitter.js";
import { sendWhatsAppMessage } from "../gateway/sendMessage.js";
import { getBehaviorConfig } from "../shared/db/tenantsDirectory.js";
import { resolveBehaviorConfig } from "./behaviorConfig.js";
import type { TurnResult } from "./loop.js";

// Estilo de mensajes (Fase 11.4 extendida, ver ADR-021): reintento chico
// del envío de UNA burbuja puntual — nunca del turno completo, eso
// dispararía una respuesta NUEVA del LLM.
const BUBBLE_SEND_ATTEMPTS = 2;
const BUBBLE_SEND_DELAY_MS = 700;

/**
 * Envía el resultado de un turno como una o varias burbujas de WhatsApp,
 * según el estilo de mensajes del tenant. Compartido entre `consumer.ts`
 * (turno inmediato) y `debounceScheduler.ts` (turno diferido, ver
 * ADR-022) — el envío es idéntico en ambos casos, solo cambia de dónde
 * viene el `TurnResult`.
 *
 * `receivedAt` es opcional: en el camino inmediato hay un único mensaje
 * que disparó el turno y tiene sentido medir latencia total desde que
 * llegó; en el camino diferido (debounce) no hay un "recibido" único
 * claro (pueden ser varios mensajes acumulados), así que ese caller no lo
 * pasa y el campo simplemente no se loguea.
 */
export async function sendTurnBubbles(
  tenantId: string,
  customerPhone: string,
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
    "Respuesta lista, enviando por Twilio",
  );
  const behaviorConfig = resolveBehaviorConfig(await getBehaviorConfig(tenantId));
  const bubbles = splitForBubbles(result.responseText, behaviorConfig.estiloMensajes);

  for (let index = 0; index < bubbles.length; index++) {
    const isLast = index === bubbles.length - 1;
    let sent = false;
    for (let attempt = 1; attempt <= BUBBLE_SEND_ATTEMPTS && !sent; attempt++) {
      try {
        await sendWhatsAppMessage(
          customerPhone,
          bubbles[index]!,
          isLast ? (result.mediaUrl ?? undefined) : undefined,
        );
        sent = true;
      } catch (error) {
        entryLogger.warn(
          { event: "gateway.envio_burbuja_fallido", index, attempt, error },
          "Fallo al enviar una burbuja, reintentando",
        );
      }
    }
    if (!sent) {
      entryLogger.error(
        { event: "gateway.envio_burbuja_perdido", index },
        "No se pudo enviar una burbuja tras reintentos — se continúa con las siguientes",
      );
    }
    if (!isLast) {
      await new Promise((resolve) => setTimeout(resolve, BUBBLE_SEND_DELAY_MS));
    }
  }

  const totalLatencyMs =
    receivedAt !== undefined && !Number.isNaN(receivedAt) ? Date.now() - receivedAt : undefined;
  entryLogger.info(
    {
      event: "gateway.confirmacion_envio",
      total_latency_ms: totalLatencyMs,
      bubble_count: bubbles.length,
    },
    "Mensaje enviado por Twilio y confirmado",
  );
}
