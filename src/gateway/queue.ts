import type { Channel } from "../shared/db/connectionsDirectory.js";
import { redis } from "../shared/redis/client.js";

/**
 * El stream conserva su nombre histórico aunque ya no sea solo de WhatsApp.
 * Renombrarlo implicaría un grupo de consumers nuevo, entradas pendientes
 * huérfanas en el stream viejo y un dead-letter partido en dos — un
 * drenaje-y-cutover deliberado que no vale la pena hasta tener tráfico real
 * de otro canal.
 */
export const INBOUND_STREAM = "whatsapp:inbound";

export interface InboundMessage {
  messageSid: string;
  customerPhone: string;
  customerName?: string;
  body: string;
  receivedAt: string;
  /** Conexión por la que entró (Fase 19) — ausente en entradas anteriores al despliegue. */
  connectionId?: string;
  channel?: Channel;
}

/**
 * Encola un mensaje entrante ya validado (firma OK, no duplicado, conexión
 * resuelta) en el stream compartido (ver
 * docs/fase-3-whatsapp-gateway/cola-mensajes.md). El mensaje es
 * deliberadamente mínimo — el orchestrator reconstruye el contexto de negocio
 * desde Postgres, la cola no es fuente de verdad de estado.
 *
 * Los campos de conexión se agregaron antes de que nadie los use a propósito:
 * agregar campos a un Redis Stream es compatible en ambos sentidos (el lector
 * busca por nombre), así que hacerlo temprano evita tener que coordinar el
 * orden de despliegue cuando el consumer empiece a necesitarlos.
 */
export async function enqueueInboundMessage(message: InboundMessage): Promise<string> {
  return redis.xadd(
    INBOUND_STREAM,
    "*",
    "message_sid",
    message.messageSid,
    "customer_phone",
    message.customerPhone,
    "customer_name",
    message.customerName ?? "",
    "body",
    message.body,
    "received_at",
    message.receivedAt,
    "connection_id",
    message.connectionId ?? "",
    "channel",
    message.channel ?? "",
  ) as Promise<string>;
}

/**
 * Lectura tolerante de una entrada del stream, compartida por el consumer.
 * Antes cada lado conocía los nombres de campo por su cuenta: el productor
 * tipado acá y el consumer con un `Record<string, string>` crudo. Este es el
 * lugar natural para los defaults de las entradas escritas por un release
 * anterior, que no traen los campos de conexión.
 */
export function parseInboundFields(fields: Record<string, string>): InboundMessage {
  return {
    messageSid: fields.message_sid ?? "",
    customerPhone: fields.customer_phone ?? "",
    customerName: fields.customer_name || undefined,
    body: fields.body ?? "",
    receivedAt: fields.received_at ?? "",
    connectionId: fields.connection_id || undefined,
    channel: (fields.channel || undefined) as Channel | undefined,
  };
}
