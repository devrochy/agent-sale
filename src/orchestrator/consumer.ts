import { INBOUND_STREAM, parseInboundFields } from "../gateway/queue.js";
import { getBehaviorConfig, getSettings } from "../shared/db/settingsDirectory.js";
import { logger } from "../shared/observability/logger.js";
import { redis } from "../shared/redis/client.js";
import { resolveBehaviorConfig, DEBOUNCE_DELAY_MS } from "./behaviorConfig.js";
import { scheduleDebounce } from "./debounceScheduler.js";
import { appendInbound, processConversation } from "./loop.js";
import { appendMessage, resolveConversation } from "./memory.js";
import { tryCaptureSurveyReply } from "./satisfactionSurvey.js";
import { sendTurnBubbles } from "./sendTurnResult.js";

const CONSUMER_GROUP = "orchestrator-group";
const CONSUMER_NAME = `orchestrator-${process.pid}`;
const DEAD_LETTER_STREAM = `${INBOUND_STREAM}:dead-letter`;
const MAX_DELIVERIES = 3;

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
async function processEntry(id: string, fields: string[]): Promise<void> {
  // El parseo vive en queue.ts, junto al productor: es donde están los
  // defaults tolerantes para las entradas escritas por un release anterior,
  // que no traen los campos de conexión (Fase 19).
  const message = parseInboundFields(fieldsToObject(fields));
  const { customerPhone, customerName, messageSid } = message;
  const origin = { connectionId: message.connectionId, channel: message.channel };

  if (!customerPhone || !messageSid) {
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
    await tryCaptureSurveyReply(customerPhone, message.body, entryLogger);

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
      await Promise.all([getSettings(), resolveConversation(customerPhone, customerName, origin)]);
    if (settings?.bot_paused || customerBotPaused || conversationBotPaused) {
      await appendMessage(pausedConversationId, "inbound", "customer", message.body);
      entryLogger.info(
        { event: "orchestrator.bot_pausado" },
        "Bot pausado — mensaje guardado sin respuesta automática",
      );
      await redis.xack(INBOUND_STREAM, CONSUMER_GROUP, id);
      return;
    }

    // Ingesta inmediata (ver ADR-022): guarda el mensaje y corre las
    // reglas que no pueden esperar (escalado ya, keyword) sin importar la
    // velocidad de respuesta configurada.
    const { conversationId, escalatedNow } = await appendInbound(
      customerPhone,
      message.body,
      customerName,
      origin,
    );

    if (escalatedNow) {
      await sendTurnBubbles(conversationId, escalatedNow, entryLogger, receivedAt);
      await redis.xack(INBOUND_STREAM, CONSUMER_GROUP, id);
      return;
    }

    const behaviorConfig = resolveBehaviorConfig(await getBehaviorConfig());
    if (behaviorConfig.velocidadRespuesta === "inmediato") {
      const result = await processConversation(customerPhone, messageSid, customerName, origin);
      await sendTurnBubbles(conversationId, result, entryLogger, receivedAt);
    } else {
      // Velocidad de respuesta (Fase 11.4 extendida, ver ADR-022): difiere
      // el disparo del turno — si llega otro mensaje de esta conversación
      // antes de que venza la ventana, scheduleDebounce la reinicia sola
      // (mismo `conversationId` como member del sorted set).
      await scheduleDebounce(conversationId, DEBOUNCE_DELAY_MS[behaviorConfig.velocidadRespuesta], {
        customerPhone,
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
    }
  }
}

async function handleReadResult(result: ReadGroupResult): Promise<void> {
  if (!result) {
    return;
  }
  for (const [, entries] of result) {
    for (const [id, fields] of entries) {
      await processEntry(id, fields);
    }
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
}

export async function startConsumer(): Promise<void> {
  await ensureConsumerGroup();
  while (true) {
    try {
      await pollOnce();
    } catch (error) {
      logger.error({ error }, "Error en el loop del consumer");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
