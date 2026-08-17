import type { Channel, ResolvedConnection } from "../shared/db/connectionsDirectory.js";
import { getConnection, getPrimaryConnection } from "../shared/db/connectionsDirectory.js";
import { pool } from "../shared/db/pool.js";
import { outboundAdapterFor } from "./channels/registry.js";

/**
 * Envío saliente del agente. No pasa por la cola de entrada (ver
 * docs/fase-3-whatsapp-gateway/cola-mensajes.md, "mensajes salientes") — es
 * una llamada síncrona disparada por el orchestrator al terminar un turno.
 *
 * Desde la Fase 19 (Etapa A) este módulo ya no habla con Twilio: resuelve la
 * conexión correcta y delega en su adapter. Hay dos formas de resolverla, y
 * la diferencia importa:
 *
 * - `sendToConversation` — para todo lo que va **al cliente**. Responde por la
 *   misma conexión por la que el cliente escribió. En cuanto exista más de
 *   una conexión, responder por otra abriría una ventana de 24h desde un
 *   número que el cliente nunca contactó, y el proveedor lo rechazaría (el
 *   63016 documentado abajo) de forma asíncrona y silenciosa.
 * - `sendToPrimary` — para lo que **no tiene conversación**: notificaciones a
 *   administradores (reporte diario, aviso de pago, escalamiento). Ahí "la
 *   conexión primary del canal" es la semántica correcta, no un default de
 *   conveniencia.
 */

interface OutboundTarget {
  connection: ResolvedConnection;
  /** Dirección del cliente en el canal — para WhatsApp, `whatsapp:+E164`. */
  to: string;
}

async function resolveTarget(conversationId: string): Promise<OutboundTarget> {
  const result = await pool.query<{
    connection_id: string | null;
    channel: Channel;
    phone_number: string;
  }>(
    `SELECT conv.connection_id, conv.channel, c.phone_number
     FROM conversations conv
     JOIN customers c ON c.id = conv.customer_id
     WHERE conv.id = $1`,
    [conversationId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`No existe la conversación ${conversationId}`);
  }

  if (row.connection_id) {
    const connection = await getConnection(row.connection_id);
    if (connection) {
      return { connection, to: row.phone_number };
    }
  }

  // Tolerante a propósito: una conversación puede no tener `connection_id`
  // si viene de antes del backfill, o apuntar a una conexión ya retirada.
  // Caer a la primary del canal es preferible a dejar al cliente sin
  // respuesta.
  return { connection: await requirePrimary(row.channel), to: row.phone_number };
}

async function requirePrimary(channel: Channel): Promise<ResolvedConnection> {
  const primary = await getPrimaryConnection(channel);
  if (!primary) {
    throw new Error(`No hay una conexión primary configurada para el canal "${channel}"`);
  }
  return primary;
}

/**
 * Devuelve el id del mensaje en el proveedor. Que esta llamada no lance solo
 * confirma que el proveedor *aceptó* el mensaje para entregarlo, no que llegó
 * al teléfono: la entrega real (o el rechazo, ej. `errorCode` 63016 de "fuera
 * de la ventana de 24h" en Twilio) se resuelve después, de forma asíncrona.
 * Quien necesite confirmarla usa `getDeliveryStatus` del adapter — ver
 * src/jobs/verifyDelivery.ts.
 */
export async function sendToConversation(
  conversationId: string,
  text: string,
  mediaUrl?: string,
): Promise<string> {
  const { connection, to } = await resolveTarget(conversationId);
  return outboundAdapterFor(connection.provider).sendText(connection, to, text, mediaUrl);
}

/** Envío sin conversación asociada — ver el docblock del módulo. */
export async function sendToPrimary(
  channel: Channel,
  to: string,
  text: string,
  mediaUrl?: string,
): Promise<string> {
  const connection = await requirePrimary(channel);
  return outboundAdapterFor(connection.provider).sendText(connection, to, text, mediaUrl);
}

/**
 * Alias histórico de `sendToPrimary("whatsapp", ...)`. Se conserva con el
 * mismo nombre y en el mismo módulo porque es lo que mockean los tests de
 * integración; los envíos al cliente van migrando a `sendToConversation`, y
 * lo que quede acá son las notificaciones a administradores, para las que
 * "la primary de WhatsApp" es la respuesta correcta.
 */
export async function sendWhatsAppMessage(
  to: string,
  body: string,
  mediaUrl?: string,
): Promise<string> {
  return sendToPrimary("whatsapp", to, body, mediaUrl);
}

export interface WhatsAppMessageStatus {
  status: string;
  errorCode: number | null;
}

/**
 * Estado real de entrega de un mensaje ya enviado. `errorCode` 63016 es el
 * caso más común en este proyecto: "fuera de la ventana de 24h", que Twilio
 * exige cubrir con un Message Template aprobado (ver ADR-019).
 *
 * Solo tiene sentido para proveedores con `deliveryModel: "poll"`. Meta
 * notifica la entrega por webhook y no admite consulta por id — de ahí que el
 * contrato de adapters use una unión discriminada y no un método opcional.
 */
export async function getWhatsAppMessageStatus(sid: string): Promise<WhatsAppMessageStatus> {
  const connection = await requirePrimary("whatsapp");
  const adapter = outboundAdapterFor(connection.provider);
  if (adapter.deliveryModel !== "poll") {
    throw new Error(
      `El proveedor "${connection.provider}" no admite consulta de entrega por id`,
    );
  }
  return adapter.getDeliveryStatus(connection, sid);
}
