import { createHash } from "node:crypto";

/**
 * Genera un idempotency_key determinístico a partir de un identificador de
 * negocio (quote_id, order_id) y un identificador estable del intento — el
 * message_sid del mensaje de WhatsApp que disparó la llamada (ver
 * docs/fase-6-dominio-comercial/flujo-cotizacion-pedido.md). A propósito NO
 * se expone como parámetro de tool al LLM (ver orchestrator/toolDefinitions.ts):
 * el mecanismo depende de datos que el modelo nunca ve, y un valor inventado
 * por el LLM no sería estable entre reintentos — igual que conversation_id,
 * lo inyecta el orquestador, no el modelo.
 *
 * Compartido entre crear_pedido (`orders.idempotency_key`) y
 * agregar_item_pedido (`order_item_batches.idempotency_key`, ver ADR-033) —
 * mismo mecanismo, dos entidades distintas.
 */
export function buildIdempotencyKey(entityId: string, messageSid: string): string {
  return createHash("sha256").update(`${entityId}:${messageSid}`).digest("hex");
}
