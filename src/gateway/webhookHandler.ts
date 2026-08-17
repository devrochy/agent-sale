import type { Provider } from "../shared/db/connectionsDirectory.js";
import { findConnectionByExternalId } from "../shared/db/connectionsDirectory.js";
import { logger } from "../shared/observability/logger.js";
import { inboundAdapterFor } from "./channels/registry.js";
import type { RawInboundRequest } from "./channels/types.js";
import { claimMessageOnce } from "./idempotency.js";
import { enqueueInboundMessage } from "./queue.js";

/**
 * Contadores en vez de un booleano: desde la Fase 19 un webhook puede traer
 * más de un mensaje (Meta manda lotes) y algunos pueden ser duplicados, algo
 * que `enqueued: boolean` no sabía describir.
 */
export interface WebhookResult {
  status: 200 | 403;
  reason:
    | "ok"
    | "invalid_signature"
    | "unknown_connection"
    | "inactive_connection"
    | "invalid_payload"
    /** El webhook solo traía callbacks de estado de entrega, no mensajes. */
    | "delivery_status";
  received: number;
  enqueued: number;
  duplicates: number;
}

function resultado(
  status: 200 | 403,
  reason: WebhookResult["reason"],
  counts: Partial<Pick<WebhookResult, "received" | "enqueued" | "duplicates">> = {},
): WebhookResult {
  return { status, reason, received: 0, enqueued: 0, duplicates: 0, ...counts };
}

/**
 * Orquesta el flujo documentado en
 * docs/fase-3-whatsapp-gateway/webhook-contrato.md, ahora agnóstico de
 * proveedor: identificar la conexión -> verificar la firma con *su*
 * credencial -> normalizar -> encolar. Sigue siendo una función pura
 * testeable sin levantar un servidor HTTP.
 *
 * Sobre los códigos de respuesta: solo una firma inválida devuelve 403. Todo
 * lo demás responde 200 aunque no se encole nada, porque un no-2xx hace que
 * el proveedor reintente indefinidamente un request que nunca va a cambiar
 * (y, en el caso de Twilio, puede terminar perdiendo el mensaje del cliente).
 */
export async function handleInboundWebhook(
  provider: Provider,
  raw: RawInboundRequest,
): Promise<WebhookResult> {
  const adapter = inboundAdapterFor(provider);

  const routingKey = adapter.identifyConnection(raw);
  if (!routingKey) {
    logger.warn({ event: "gateway.sin_clave_de_ruteo", provider }, "Webhook sin clave de ruteo");
    return resultado(200, "unknown_connection");
  }

  const connection = await findConnectionByExternalId(provider, routingKey);
  if (!connection) {
    logger.warn(
      { event: "gateway.conexion_desconocida", provider, routing_key: routingKey },
      "Webhook de una conexión que no está configurada",
    );
    return resultado(200, "unknown_connection");
  }

  if (!adapter.verifyRequest(connection.credentials, raw)) {
    return resultado(403, "invalid_signature");
  }

  // Una conexión inactiva no encola ni responde, pero contesta 200: con un
  // 403 el proveedor reintentaría y el mensaje del cliente se perdería en
  // silencio al agotar los reintentos.
  if (!connection.active) {
    logger.info(
      { event: "gateway.conexion_inactiva", connection_id: connection.id },
      "Mensaje descartado: la conexión está inactiva",
    );
    return resultado(200, "inactive_connection");
  }

  // Los proveedores que notifican la entrega por webhook (Meta) la mandan por
  // este mismo endpoint. Es la señal equivalente al `63016` de Twilio: sin
  // esto, un mensaje rechazado por ventana de 24 h vencida se perdería en
  // silencio, que es justo el hallazgo de QA que originó verifyDelivery.ts.
  const estados = adapter.parseDeliveryStatuses?.(raw) ?? [];
  for (const estado of estados) {
    if (estado.status !== "failed") {
      continue;
    }
    logger.warn(
      {
        event: "delivery.rechazado",
        connection_id: connection.id,
        external_message_id: estado.externalMessageId,
        destinatario: estado.recipientExternalId,
        error_code: estado.errorCode,
        motivo: estado.errorMessage,
      },
      "El proveedor rechazó la entrega de un mensaje ya enviado",
    );
  }

  const mensajes = adapter.parseInbound(raw);
  if (mensajes.length === 0) {
    // Normal, no un error: un webhook puede traer solo estados de entrega.
    return resultado(200, estados.length > 0 ? "delivery_status" : "invalid_payload");
  }

  let enqueued = 0;
  let duplicates = 0;

  for (const mensaje of mensajes) {
    const esNuevo = await claimMessageOnce(provider, mensaje.externalMessageId);
    if (!esNuevo) {
      duplicates += 1;
      continue;
    }

    const log = logger.child({ message_sid: mensaje.externalMessageId });
    log.info({ event: "gateway.mensaje_recibido" }, "Mensaje entrante recibido");

    await enqueueInboundMessage({
      messageSid: mensaje.externalMessageId,
      customerExternalId: mensaje.customerExternalId,
      customerName: mensaje.customerName,
      body: mensaje.body,
      receivedAt: mensaje.receivedAt,
      connectionId: connection.id,
      channel: connection.channel,
    });
    enqueued += 1;

    log.info({ event: "gateway.encolado" }, "Mensaje entrante encolado");
  }

  return resultado(200, "ok", { received: mensajes.length, enqueued, duplicates });
}
