import { redis } from "../shared/redis/client.js";

export const INBOUND_STREAM = "whatsapp:inbound";

export interface InboundMessage {
  messageSid: string;
  tenantId: string;
  customerPhone: string;
  body: string;
  receivedAt: string;
}

/**
 * Encola un mensaje entrante ya validado (firma OK, no duplicado, tenant
 * resuelto) en el stream compartido (ver
 * docs/fase-3-whatsapp-gateway/cola-mensajes.md). El mensaje es
 * deliberadamente mínimo — el orchestrator reconstruye el contexto de
 * negocio desde Postgres, la cola no es fuente de verdad de estado.
 */
export async function enqueueInboundMessage(message: InboundMessage): Promise<string> {
  return redis.xadd(
    INBOUND_STREAM,
    "*",
    "message_sid",
    message.messageSid,
    "tenant_id",
    message.tenantId,
    "customer_phone",
    message.customerPhone,
    "body",
    message.body,
    "received_at",
    message.receivedAt,
  ) as Promise<string>;
}
