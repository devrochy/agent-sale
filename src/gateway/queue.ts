import type { Channel } from "../shared/db/connectionsDirectory.js";
import type { InboundMediaRef } from "./channels/types.js";
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
  /**
   * Dirección del cliente **dentro de su canal**, en el canónico del sistema
   * (`whatsapp:+E164`). Desde la Etapa C1 no es necesariamente un teléfono: en
   * Instagram y Messenger es un identificador opaco. El campo del stream
   * conserva el nombre `customer_phone` por la misma razón que el stream
   * conserva el suyo — renombrarlo dejaría sin leer las entradas en vuelo, y
   * es además la clave que `REDACT_PATHS` censura en los logs.
   */
  customerExternalId: string;
  customerName?: string;
  body: string;
  receivedAt: string;
  /** Conexión por la que entró (Fase 19) — ausente en entradas anteriores al despliegue. */
  connectionId?: string;
  channel?: Channel;
  /** Ausente para texto normal — presente cuando el cliente mandó una imagen o un audio (ver InboundMediaRef). */
  media?: InboundMediaRef;
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
    message.customerExternalId,
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
    // Serializado y no campos sueltos (a diferencia del resto): es un objeto
    // chico y opcional, y una entrada Redis Stream no tiene forma de
    // representar "campo ausente" salvo con una convención propia — un JSON
    // vacío ("") ya la expresa sin inventar una.
    "media_json",
    message.media ? JSON.stringify(message.media) : "",
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
  let media: InboundMediaRef | undefined;
  if (fields.media_json) {
    try {
      media = JSON.parse(fields.media_json) as InboundMediaRef;
    } catch {
      // Entrada corrupta o de un formato futuro que este release no conoce
      // todavía — se procesa igual como si fuera texto, no se descarta el
      // mensaje entero por esto.
      media = undefined;
    }
  }
  return {
    messageSid: fields.message_sid ?? "",
    customerExternalId: fields.customer_phone ?? "",
    customerName: fields.customer_name || undefined,
    body: fields.body ?? "",
    receivedAt: fields.received_at ?? "",
    connectionId: fields.connection_id || undefined,
    channel: (fields.channel || undefined) as Channel | undefined,
    media,
  };
}
