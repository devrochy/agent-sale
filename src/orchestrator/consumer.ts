import { sendWhatsAppMessage } from "../gateway/sendMessage.js";
import { INBOUND_STREAM } from "../gateway/queue.js";
import { redis } from "../shared/redis/client.js";
import { runTurn } from "./loop.js";

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

  if (!tenantId || !customerPhone) {
    // Payload inválido: no hay nada que reintentar, se descarta.
    await redis.xack(INBOUND_STREAM, CONSUMER_GROUP, id);
    return;
  }

  console.log(`[orchestrator] mensaje ${id} de ${customerPhone}: "${message.body ?? ""}"`);

  try {
    const { responseText } = await runTurn(tenantId, customerPhone, message.body ?? "");
    console.log(`[orchestrator] respuesta calculada para ${customerPhone}: "${responseText}"`);
    await sendWhatsAppMessage(customerPhone, responseText);
    console.log(`[orchestrator] mensaje ${id} enviado por Twilio y confirmado (ack)`);
    await redis.xack(INBOUND_STREAM, CONSUMER_GROUP, id);
  } catch (error) {
    const pending = (await redis.xpending(INBOUND_STREAM, CONSUMER_GROUP, id, id, 1)) as Array<
      [string, string, number, number]
    >;
    const deliveryCount = pending[0] ? Number(pending[0][3]) : 1;
    if (deliveryCount >= MAX_DELIVERIES) {
      await moveToDeadLetter(id, fields);
      console.error(`Mensaje ${id} movido a dead-letter tras ${deliveryCount} intentos`, error);
    } else {
      console.error(`Error procesando mensaje ${id} (intento ${deliveryCount})`, error);
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
      console.error("Error en el loop del consumer", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
