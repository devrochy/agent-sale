import type { Channel } from "../shared/db/connectionsDirectory.js";
import { withTransaction } from "../shared/db/withTransaction.js";
import { logger } from "../shared/observability/logger.js";
import { redis } from "../shared/redis/client.js";
import { getSettings } from "../shared/db/settingsDirectory.js";
import { recordDebounceFailure } from "./debounceFailures.js";
import { processConversation } from "./loop.js";
import { sendTurnBubbles } from "./sendTurnResult.js";

// Velocidad de respuesta (Fase 11.4 extendida, ver ADR-022): cola de
// espera sobre un Redis Sorted Set (score = timestamp ms de disparo).
// `ZADD` sobre un member existente actualiza su score — un mensaje nuevo
// de la misma conversación "reinicia el timer" sin lógica adicional.
const PENDING_KEY = "debounce:pending";
const PAYLOAD_KEY_PREFIX = "debounce:payload:";
const POLL_INTERVAL_MS = 1500;

// Reintento del disparo del turno (Fase 2 del plan de remediación del
// incidente 2026-09-13, ver docblock de fireConversation más abajo). Mismo
// criterio de "un reintento corto basta" que BUBBLE_SEND_ATTEMPTS en
// sendTurnResult.ts.
const FIRE_ATTEMPTS = 2;
const FIRE_RETRY_DELAY_MS = 2_000;

export interface DebouncePayload {
  customerExternalId: string;
  messageSid: string;
  customerName?: string;
  /**
   * Origen del mensaje (Fase 19). Opcionales a propósito y leídos de forma
   * tolerante: los payloads que quedaron escritos en Redis por el release
   * anterior no los traen, y `debounce:payload:*` no tiene TTL. Sin esta
   * tolerancia, un despliegue dejaría mudas todas las conversaciones con un
   * turno diferido en vuelo — `fireConversation` no reintenta.
   */
  connectionId?: string;
  channel?: Channel;
}

/**
 * Programa (o reprograma) el disparo de `processConversation` para esta
 * conversación. El payload se guarda aparte del score porque el `member`
 * del sorted set tiene que ser estable (siempre `conversationId`) para
 * que reprogramar sea gratis — si el member cambiara con cada mensaje
 * (ej. si incluyera el `messageSid`), cada mensaje nuevo crearía una
 * entrada distinta en vez de reiniciar el timer existente.
 */
export async function scheduleDebounce(
  conversationId: string,
  delayMs: number,
  payload: DebouncePayload,
): Promise<void> {
  await redis.set(`${PAYLOAD_KEY_PREFIX}${conversationId}`, JSON.stringify(payload));
  await redis.zadd(PENDING_KEY, Date.now() + delayMs, conversationId);
}

/** Cancela un timer pendiente — usado cuando un mensaje escala de inmediato (ver appendInbound en loop.ts) y no tiene sentido esperar la ventana. No falla si no había nada pendiente. */
export async function cancelDebounce(conversationId: string): Promise<void> {
  await redis.zrem(PENDING_KEY, conversationId);
  await redis.del(`${PAYLOAD_KEY_PREFIX}${conversationId}`);
}

/**
 * Sin backing de Redis Streams acá (el mensaje ya se hizo ACK al
 * ingerirse, ver consumer.ts) — por eso el reintento vive acá, no en el
 * consumer. Reintenta el turno completo (`processConversation` +
 * `sendTurnBubbles`), no solo el envío: es seguro porque las tools de
 * escritura con efecto real (crear_pedido, agregar_item_pedido) tienen su
 * propio idempotency_key atado al `messageSid` del payload — que no
 * cambia entre intentos — y crear_pedido además chequea `quote_id`
 * duplicado *antes* de llamar a Wompi o insertar, así que un segundo
 * intento nunca duplica un pedido ni un cobro (ver
 * domains/commerce/crearPedido.ts, domains/commerce/idempotency.ts).
 *
 * Si el segundo intento también falla, se agotan los reintentos (Fase 2
 * del plan de remediación del incidente 2026-09-13 — cierra el límite que
 * ADR-022 dejaba conocido y sin resolver) y el fallo se registra en
 * `debounce_failures` para que quede consultable por un humano, no solo
 * en el log. El mensaje del cliente ya está guardado en Postgres, no se
 * pierde; sí queda sin respuesta hasta que llegue un mensaje nuevo (que
 * dispara un turno fresco) o se detecte en el barrido de recuperación del
 * próximo arranque.
 */
export async function fireConversation(conversationId: string, payload: DebouncePayload): Promise<void> {
  const turnLogger = logger.child({ conversation_id: conversationId });

  for (let attempt = 1; attempt <= FIRE_ATTEMPTS; attempt++) {
    try {
      const result = await processConversation(
        payload.customerExternalId,
        payload.messageSid,
        payload.customerName,
        { connectionId: payload.connectionId, channel: payload.channel },
      );
      await sendTurnBubbles(conversationId, result, turnLogger);
      return;
    } catch (error) {
      const isLastAttempt = attempt === FIRE_ATTEMPTS;
      turnLogger.error(
        {
          error,
          attempt,
          event: isLastAttempt ? "orchestrator.debounce_disparo_fallido" : "orchestrator.debounce_disparo_reintentando",
        },
        isLastAttempt ? "Error disparando turno diferido, sin más reintentos" : "Error disparando turno diferido, reintentando",
      );

      if (!isLastAttempt) {
        await new Promise((resolve) => setTimeout(resolve, FIRE_RETRY_DELAY_MS));
        continue;
      }

      await recordDebounceFailure(conversationId, error, FIRE_ATTEMPTS).catch((persistError) => {
        turnLogger.error(
          { error: persistError },
          "No se pudo registrar el fallo de debounce en debounce_failures — sigue quedando solo en el log",
        );
      });
    }
  }
}

async function pollDebounceOnce(): Promise<void> {
  const now = Date.now();
  const candidates = await redis.zrangebyscore(PENDING_KEY, "-inf", now);
  for (const conversationId of candidates) {
    // Claim atómico por candidato individual (no leer-en-batch y remover-
    // en-batch): si en algún momento corre más de una réplica del
    // proceso sobre el mismo Redis, solo la que gane el ZREM (devuelve 1)
    // dispara el turno — evita doble disparo. Hoy es 1 réplica, pero el
    // costo de hacerlo bien es cero.
    const claimed = await redis.zrem(PENDING_KEY, conversationId);
    if (claimed !== 1) {
      continue;
    }
    const payloadRaw = await redis.get(`${PAYLOAD_KEY_PREFIX}${conversationId}`);
    await redis.del(`${PAYLOAD_KEY_PREFIX}${conversationId}`);
    if (!payloadRaw) {
      // No debería pasar (scheduleDebounce siempre escribe el payload
      // antes del ZADD) — defensivo, no hay nada que disparar sin él.
      logger.warn(
        { conversation_id: conversationId },
        "Timer de debounce sin payload asociado, se descarta",
      );
      continue;
    }
    const payload = JSON.parse(payloadRaw) as DebouncePayload;
    await fireConversation(conversationId, payload);
  }
}

interface OrphanRow {
  conversation_id: string;
  external_id: string;
  customer_name: string | null;
  connection_id: string | null;
  channel: Channel;
}

/**
 * Barrido único al arrancar (ver ADR-022, "recuperación de crash a mitad
 * de ventana"): si el proceso murió con un timer de debounce en el aire,
 * el mensaje del cliente no se pierde (ya está en Postgres desde
 * `appendInbound`), pero el disparo sí — sin este barrido la conversación
 * queda colgada indefinidamente. Detecta conversaciones abiertas, no
 * escaladas, cuyo último mensaje es inbound (el cliente — o una
 * tool_result intermedia — está esperando una respuesta que nunca llegó)
 * y no tienen ya un timer vivo, y las reprograma con score=now (no hace
 * esperar de nuevo la ventana completa).
 */
async function recoverOrphanedConversations(): Promise<void> {
  const settings = await getSettings();
  if (settings?.bot_paused) {
    return;
  }

  const orphans = await withTransaction((client) =>
    client.query<OrphanRow>(`
      SELECT conv.id AS conversation_id, c.external_id, c.name AS customer_name,
             conv.connection_id, conv.channel
      FROM conversations conv
      JOIN customers c ON c.id = conv.customer_id
      JOIN LATERAL (
        SELECT direction FROM messages
        WHERE conversation_id = conv.id
        ORDER BY created_at DESC LIMIT 1
      ) last_msg ON true
      WHERE conv.status = 'open'
        AND (conv.state ->> 'step') IS DISTINCT FROM 'escalado'
        AND last_msg.direction = 'inbound'
        AND c.bot_paused = false -- kill-switch por cliente (Fase 23/ADR-036)
        AND conv.bot_paused = false -- kill-switch por conversación puntual (Fase 18)
    `),
  );

  for (const row of orphans.rows) {
    const pending = await redis.zscore(PENDING_KEY, row.conversation_id);
    if (pending !== null) {
      // Ya tiene un timer vivo (mensaje reciente que sí se programó bien) — no tocar.
      continue;
    }
    logger.warn(
      { conversation_id: row.conversation_id },
      "Conversación huérfana detectada al arrancar — se reprograma para disparar de inmediato",
    );
    // messageSid sintético: no hay un Sid real disponible acá (el
    // original ya se usó/perdió) — solo importa para el idempotency_key
    // de crear_pedido, que tolera un valor nunca antes visto.
    await scheduleDebounce(row.conversation_id, 0, {
      customerExternalId: row.external_id,
      messageSid: `recovery-${row.conversation_id}`,
      customerName: row.customer_name ?? undefined,
      connectionId: row.connection_id ?? undefined,
      channel: row.channel,
    });
  }
}

export async function startDebounceScheduler(): Promise<void> {
  await recoverOrphanedConversations();
  while (true) {
    try {
      await pollDebounceOnce();
    } catch (error) {
      logger.error({ error }, "Error en el loop del debounce scheduler");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
