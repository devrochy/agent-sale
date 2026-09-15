import { INBOUND_STREAM, parseInboundFields } from "../gateway/queue.js";
import { getBehaviorConfig, getSettings } from "../shared/db/settingsDirectory.js";
import { logger } from "../shared/observability/logger.js";
import { redis } from "../shared/redis/client.js";
import { resolveBehaviorConfig, DEBOUNCE_DELAY_MS } from "./behaviorConfig.js";
import { scheduleDebounce } from "./debounceScheduler.js";
import { appendInbound, processConversation } from "./loop.js";
import { procesarMediaEntrante } from "./mediaIngestion.js";
import { appendMessage, resolveConversation } from "./memory.js";
import { tryCaptureSurveyReply } from "./satisfactionSurvey.js";
import { sendTurnBubbles } from "./sendTurnResult.js";

const CONSUMER_GROUP = "orchestrator-group";
const CONSUMER_NAME = `orchestrator-${process.pid}`;
const DEAD_LETTER_STREAM = `${INBOUND_STREAM}:dead-letter`;
const MAX_DELIVERIES = 3;
// Backoff entre reintentos de un mensaje que falló (ver el catch de
// processEntry más abajo): sin esto, la siguiente iteración del loop lo
// reintenta en caliente de inmediato — bien si el fallo fue un error de
// negocio puntual, pero contraproducente si fue un rate limit o un
// proveedor momentáneamente caído (reintentar más rápido no ayuda).
// Crece con el intento porque como mucho hay 2 reintentos antes del
// dead-letter (MAX_DELIVERIES=3) — no hace falta un techo.
const RETRY_BACKOFF_BASE_MS = 2_000;

// Recuperación de entradas huérfanas al arrancar (Fase 5 del plan de
// remediación del incidente 2026-09-13, ver claimOrphanedEntries más
// abajo). 60s de margen generoso sobre TIMEOUT_LLM_MS (45s, ver
// env.llmTimeoutMs) — no debe reclamar trabajo de un consumer que todavía
// está legítimamente esperando una respuesta lenta del LLM.
const CLAIM_MIN_IDLE_MS = 60_000;
const CLAIM_BATCH = 20;

// Liveness del consumer (ver /healthz en gateway/server.ts, incidente
// 2026-09-13): timestamp en memoria del proceso, actualizado al terminar
// cada pollOnce() completo. Deliberadamente NO se actualiza al empezar el
// poll — si processEntry() queda colgado dentro del `for` de
// handleReadResult, lastPollAt deja de avanzar y /healthz puede detectarlo,
// en vez de seguir pareciendo "vivo" mientras el pipeline está bloqueado.
let lastPollAt = Date.now();

export function getConsumerLastPollAt(): number {
  return lastPollAt;
}

// Graceful shutdown (Fase 4 del plan de remediación del incidente
// 2026-09-13, ver src/index.ts): al recibir SIGTERM, el proceso deja de
// tomar entradas NUEVAS del stream, pero termina la que ya está en curso
// — un redeploy no debe cortar un turno a mitad de camino.
let shuttingDown = false;

export function requestConsumerShutdown(): void {
  shuttingDown = true;
}

type StreamEntries = Array<[string, string[]]>;
type ReadGroupResult = Array<[string, StreamEntries]> | null;

async function ensureConsumerGroup(): Promise<void> {
  try {
    await redis.xgroup("CREATE", INBOUND_STREAM, CONSUMER_GROUP, "$", "MKSTREAM");
  } catch (error) {
    const isBusyGroup = error instanceof Error && error.message.includes("BUSYGROUP");
    if (!isBusyGroup) {
      throw error;
    }
  }
}

function fieldsToObject(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]!] = fields[i + 1]!;
  }
  return obj;
}

async function moveToDeadLetter(id: string, fields: string[]): Promise<void> {
  await redis.xadd(DEAD_LETTER_STREAM, "*", ...fields);
  await redis.xack(INBOUND_STREAM, CONSUMER_GROUP, id);
}

/**
 * Procesa una entrada del stream (ver docs/fase-3-whatsapp-gateway/cola-mensajes.md,
 * "reintentos y dead-letter"): si falla, se deja sin XACK para reintento
 * automático del consumer group hasta MAX_DELIVERIES; después de eso pasa
 * a whatsapp:inbound:dead-letter.
 */
export async function processEntry(id: string, fields: string[]): Promise<void> {
  // El parseo vive en queue.ts, junto al productor: es donde están los
  // defaults tolerantes para las entradas escritas por un release anterior,
  // que no traen los campos de conexión (Fase 19).
  const message = parseInboundFields(fieldsToObject(fields));
  const { customerExternalId, customerName, messageSid } = message;
  const origin = { connectionId: message.connectionId, channel: message.channel };

  if (!customerExternalId || !messageSid) {
    // Payload inválido: no hay nada que reintentar, se descarta.
    await redis.xack(INBOUND_STREAM, CONSUMER_GROUP, id);
    return;
  }

  const entryLogger = logger.child({ message_sid: messageSid });
  const receivedAt = message.receivedAt ? Date.parse(message.receivedAt) : NaN;
  const queueLatencyMs = Number.isNaN(receivedAt) ? undefined : Date.now() - receivedAt;
  entryLogger.info(
    { event: "orchestrator.mensaje_tomado", queue_latency_ms: queueLatencyMs },
    "Mensaje tomado de la cola",
  );

  try {
    // Encuesta de satisfacción (Fase 12.2, ver satisfactionSurvey.ts):
    // efecto secundario NO bloqueante, primero de todo así cubre bot
    // pausado / inmediato / debounce con un único call-site — el mensaje
    // sigue su curso normal después, se haya capturado una calificación
    // pendiente o no.
    await tryCaptureSurveyReply(
      customerExternalId,
      origin.channel ?? "whatsapp",
      message.body,
      entryLogger,
    );

    // Kill-switch (Fase 11.4, ver configuracion-comportamiento.md; extendido
    // en Fase 23/ADR-036 con un segundo nivel por cliente): se chequea ACÁ,
    // antes de invocar el orquestador — así se evita resolver el proveedor
    // de LLM (y su costo) con el bot pausado. El mensaje del cliente se
    // guarda igual (mismo par de llamadas que usa appendInbound) para no
    // perder historial mientras el bot está pausado; si se reactiva, el
    // operador lo ve pendiente en el inbox de Conversaciones.
    // Deliberadamente NO pasa por appendInbound (que podría escalar por
    // palabra clave y mandar un mensaje automático de fallback) — un bot
    // pausado no manda absolutamente nada. `settings.bot_paused` (global),
    // `customers.bot_paused` (por cliente) y `conversations.bot_paused`
    // (por conversación puntual, Fase 18) se combinan con OR — pausado en
    // cualquiera de los tres niveles alcanza para no responder.
    const [settings, { conversationId: pausedConversationId, customerBotPaused, conversationBotPaused }] =
      await Promise.all([getSettings(), resolveConversation(customerExternalId, customerName, origin)]);
    if (settings?.bot_paused || customerBotPaused || conversationBotPaused) {
      await appendMessage(
        pausedConversationId,
        "inbound",
        "customer",
        message.body || (message.media ? `[${message.media.type === "image" ? "Imagen" : "Audio"} adjunto]` : ""),
      );
      entryLogger.info(
        { event: "orchestrator.bot_pausado" },
        "Bot pausado — mensaje guardado sin respuesta automática",
      );
      await redis.xack(INBOUND_STREAM, CONSUMER_GROUP, id);
      return;
    }

    // Medios entrantes (imagen/audio) — ruteo determinístico, nunca pasa
    // por el LLM (ver mediaIngestion.ts). "no_manejado" es el mismo
    // descarte silencioso que existía antes de esta feature (ahora vive
    // acá y no en el parseo del webhook); "procesado_completo" ya mandó su
    // propia respuesta (comprobante, o "no te entendí" de un audio) y no
    // debe pasar por el LLM; "continuar_como_texto" reemplaza el body por
    // la transcripción y sigue el camino normal de abajo, como si el
    // cliente lo hubiera tipeado.
    let body = message.body;
    if (message.media) {
      const resultado = await procesarMediaEntrante(message, origin, entryLogger);
      if (resultado.kind === "no_manejado") {
        entryLogger.info(
          { event: "gateway.mensaje_meta_ignorado", tipo: message.media.type },
          "Media entrante sin manejo automático todavía — se descarta",
        );
        await redis.xack(INBOUND_STREAM, CONSUMER_GROUP, id);
        return;
      }
      if (resultado.kind === "procesado_completo") {
        await redis.xack(INBOUND_STREAM, CONSUMER_GROUP, id);
        return;
      }
      body = resultado.texto;
    }

    // Ingesta inmediata (ver ADR-022): guarda el mensaje y corre las
    // reglas que no pueden esperar (escalado ya, keyword) sin importar la
    // velocidad de respuesta configurada.
    const { conversationId, escalatedNow } = await appendInbound(customerExternalId, body, customerName, origin);

    if (escalatedNow) {
      await sendTurnBubbles(conversationId, escalatedNow, entryLogger, receivedAt);
      await redis.xack(INBOUND_STREAM, CONSUMER_GROUP, id);
      return;
    }

    const behaviorConfig = resolveBehaviorConfig(await getBehaviorConfig());
    if (behaviorConfig.velocidadRespuesta === "inmediato") {
      const result = await processConversation(customerExternalId, messageSid, customerName, origin);
      await sendTurnBubbles(conversationId, result, entryLogger, receivedAt);
    } else {
      // Velocidad de respuesta (Fase 11.4 extendida, ver ADR-022): difiere
      // el disparo del turno — si llega otro mensaje de esta conversación
      // antes de que venza la ventana, scheduleDebounce la reinicia sola
      // (mismo `conversationId` como member del sorted set).
      await scheduleDebounce(conversationId, DEBOUNCE_DELAY_MS[behaviorConfig.velocidadRespuesta], {
        customerExternalId,
        messageSid,
        customerName,
        connectionId: origin.connectionId,
        channel: origin.channel,
      });
      entryLogger.info(
        { event: "orchestrator.turno_diferido", velocidad: behaviorConfig.velocidadRespuesta },
        "Turno diferido por debounce, se disparará cuando venza la ventana",
      );
    }

    await redis.xack(INBOUND_STREAM, CONSUMER_GROUP, id);
  } catch (error) {
    const pending = (await redis.xpending(INBOUND_STREAM, CONSUMER_GROUP, id, id, 1)) as Array<
      [string, string, number, number]
    >;
    const deliveryCount = pending[0] ? Number(pending[0][3]) : 1;
    if (deliveryCount >= MAX_DELIVERIES) {
      await moveToDeadLetter(id, fields);
      entryLogger.error({ error, delivery_count: deliveryCount }, "Mensaje movido a dead-letter");
    } else {
      entryLogger.error({ error, delivery_count: deliveryCount }, "Error procesando mensaje, se reintentará");
      await new Promise((resolve) => setTimeout(resolve, deliveryCount * RETRY_BACKOFF_BASE_MS));
    }
  }
}

async function handleReadResult(result: ReadGroupResult): Promise<void> {
  if (!result) {
    return;
  }
  for (const [, entries] of result) {
    for (const [id, fields] of entries) {
      if (shuttingDown) {
        // No arranca una entrada nueva del batch — queda sin XACK, se
        // reprocesa al reiniciar (Fase 5, XAUTOCLAIM, la recupera aunque
        // el próximo proceso tenga un CONSUMER_NAME distinto). La entrada
        // que ya estaba en curso (el `await processEntry` anterior en este
        // mismo `for`) sí terminó de correr antes de llegar acá.
        return;
      }
      await processEntry(id, fields);
    }
  }
}

/**
 * Reclama entradas "pending" de un consumer que ya no existe — sin esto
 * quedan huérfanas para siempre. `CONSUMER_NAME` depende del PID (ver
 * arriba): cada arranque del proceso es un consumer distinto dentro del
 * mismo `CONSUMER_GROUP`, y `pollOnce` (con ID "0") solo relee las
 * pendientes de su PROPIO nombre — nunca las de un consumer viejo que
 * murió a mitad de un `processEntry` (crash real, `kill -9`, o un SIGKILL
 * que llegó antes de que el graceful shutdown terminara). `XAUTOCLAIM`
 * (Redis ≥6.2) es la herramienta hecha para esto: transfiere de a lotes
 * las entradas con más de `CLAIM_MIN_IDLE_MS` sin actividad de su
 * consumer original al `CONSUMER_NAME` actual.
 *
 * Corre una sola vez al arrancar (mismo criterio que
 * `recoverOrphanedConversations()` en debounceScheduler.ts, para el caso
 * equivalente del debounce) — no periódico: con los timeouts de la Fase 1
 * y el graceful shutdown de la Fase 4, el escenario real que esto cubre
 * es específicamente "el proceso murió sin completar un shutdown
 * ordenado", que solo puede haber pasado antes de este arranque.
 */
export async function claimOrphanedEntries(): Promise<void> {
  let cursor = "0";
  let totalClaimed = 0;
  do {
    const [nextCursor, entries] = (await redis.xautoclaim(
      INBOUND_STREAM,
      CONSUMER_GROUP,
      CONSUMER_NAME,
      CLAIM_MIN_IDLE_MS,
      cursor,
      "COUNT",
      CLAIM_BATCH,
    )) as [string, StreamEntries, string[]];
    cursor = nextCursor;
    if (entries.length > 0) {
      totalClaimed += entries.length;
      await handleReadResult([[INBOUND_STREAM, entries]]);
    }
    // Ojo: el cursor "sin más páginas" que devuelve Redis es "0-0" (el ID
    // completo, ms-seq), no el "0" corto que se manda como punto de
    // partida — verificado contra un Redis real, no solo con mocks (con
    // un mock ingenuo este chequeo pasa igual comparando contra "0" y
    // queda un loop que nunca termina en producción).
  } while (cursor !== "0" && cursor !== "0-0");

  if (totalClaimed > 0) {
    logger.warn(
      { event: "orchestrator.entradas_huerfanas_reclamadas", count: totalClaimed },
      "Entradas huérfanas reclamadas de un consumer muerto y procesadas",
    );
  }
}

async function pollOnce(): Promise<void> {
  // Primero reintenta las entradas pendientes propias de este consumer
  // (ID "0"), luego lee entradas nuevas (">").
  const pending = (await redis.xreadgroup(
    "GROUP",
    CONSUMER_GROUP,
    CONSUMER_NAME,
    "COUNT",
    10,
    "STREAMS",
    INBOUND_STREAM,
    "0",
  )) as ReadGroupResult;
  await handleReadResult(pending);

  const fresh = (await redis.xreadgroup(
    "GROUP",
    CONSUMER_GROUP,
    CONSUMER_NAME,
    "COUNT",
    10,
    "BLOCK",
    5000,
    "STREAMS",
    INBOUND_STREAM,
    ">",
  )) as ReadGroupResult;
  await handleReadResult(fresh);
  lastPollAt = Date.now();
}

export async function startConsumer(): Promise<void> {
  await ensureConsumerGroup();
  await claimOrphanedEntries();
  while (!shuttingDown) {
    try {
      await pollOnce();
    } catch (error) {
      logger.error({ error }, "Error en el loop del consumer");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
