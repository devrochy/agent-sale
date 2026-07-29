import { sendWhatsAppMessage } from "../gateway/sendMessage.js";
import { INBOUND_STREAM } from "../gateway/queue.js";
import { getTenant } from "../shared/db/tenantsDirectory.js";
import { logger } from "../shared/observability/logger.js";
import { redis } from "../shared/redis/client.js";
import { runTurn } from "./loop.js";
import { appendMessage, resolveConversation } from "./memory.js";

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
  const message = fieldsToObject(fields);
  const tenantId = message.tenant_id;
  const customerPhone = message.customer_phone;
  const customerName = message.customer_name || undefined;
  const messageSid = message.message_sid;

  if (!tenantId || !customerPhone || !messageSid) {
    // Payload inválido: no hay nada que reintentar, se descarta.
    await redis.xack(INBOUND_STREAM, CONSUMER_GROUP, id);
    return;
  }

  const entryLogger = logger.child({ tenant_id: tenantId, message_sid: messageSid });
  const receivedAt = message.received_at ? Date.parse(message.received_at) : NaN;
  const queueLatencyMs = Number.isNaN(receivedAt) ? undefined : Date.now() - receivedAt;
  entryLogger.info(
    { event: "orchestrator.mensaje_tomado", queue_latency_ms: queueLatencyMs },
    "Mensaje tomado de la cola",
  );

  try {
    // Kill-switch (Fase 11.4, ver configuracion-comportamiento.md): se
    // chequea ACÁ, antes de invocar el orquestador — así se evita
    // resolver el proveedor de LLM (y su costo) para un tenant pausado.
    // El mensaje del cliente se guarda igual (mismo par de llamadas que
    // hace runTurn al principio) para no perder historial mientras el
    // bot está pausado; si se reactiva, el operador lo ve pendiente en
    // el inbox de Conversaciones.
    const tenant = await getTenant(tenantId);
    if (tenant?.bot_paused) {
      const { conversationId } = await resolveConversation(tenantId, customerPhone, customerName);
      await appendMessage(tenantId, conversationId, "inbound", "customer", message.body ?? "");
      entryLogger.info(
        { event: "orchestrator.bot_pausado" },
        "Bot pausado para este tenant — mensaje guardado sin respuesta automática",
      );
      await redis.xack(INBOUND_STREAM, CONSUMER_GROUP, id);
      return;
    }

    const { responseText, mediaUrl } = await runTurn(
      tenantId,
      customerPhone,
      message.body ?? "",
      messageSid,
      customerName,
    );
    if (responseText !== null) {
      entryLogger.info({ event: "orchestrator.respuesta_lista" }, "Respuesta lista, enviando por Twilio");
      await sendWhatsAppMessage(customerPhone, responseText, mediaUrl ?? undefined);
      const totalLatencyMs = Number.isNaN(receivedAt) ? undefined : Date.now() - receivedAt;
      entryLogger.info(
        { event: "gateway.confirmacion_envio", total_latency_ms: totalLatencyMs },
        "Mensaje enviado por Twilio y confirmado",
      );
    } else {
      entryLogger.info(
        { event: "orchestrator.conversacion_escalada" },
        "Conversación ya escalada, sin respuesta automática",
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
