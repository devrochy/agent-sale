import { findTenantIdByWhatsappNumber } from "../shared/db/index.js";
import { claimMessageOnce } from "./idempotency.js";
import { enqueueInboundMessage } from "./queue.js";
import { verifyTwilioSignature } from "./twilioSignature.js";

export interface WebhookResult {
  status: 200 | 403;
  enqueued: boolean;
  reason: "ok" | "invalid_signature" | "invalid_payload" | "duplicate" | "unknown_tenant";
}

/**
 * Orquesta el flujo documentado en
 * docs/fase-3-whatsapp-gateway/webhook-contrato.md como función pura,
 * testeable sin levantar un servidor HTTP real.
 */
export async function handleInboundWebhook(
  params: Record<string, string>,
  signatureHeader: string | undefined,
): Promise<WebhookResult> {
  if (!verifyTwilioSignature(params, signatureHeader)) {
    return { status: 403, enqueued: false, reason: "invalid_signature" };
  }

  const messageSid = params.MessageSid;
  const from = params.From;
  const to = params.To;
  const body = params.Body ?? "";

  if (!messageSid || !from || !to) {
    // La firma ya es válida (viene de Twilio), pero falta un campo
    // requerido — no se reintenta un payload que nunca va a cambiar.
    return { status: 200, enqueued: false, reason: "invalid_payload" };
  }

  const isNew = await claimMessageOnce(messageSid);
  if (!isNew) {
    return { status: 200, enqueued: false, reason: "duplicate" };
  }

  const tenantId = await findTenantIdByWhatsappNumber(to);
  if (!tenantId) {
    // Evita tormenta de reintentos de Twilio: se responde 200 igual,
    // solo que sin encolar (ver plan del incremento).
    return { status: 200, enqueued: false, reason: "unknown_tenant" };
  }

  await enqueueInboundMessage({
    messageSid,
    tenantId,
    customerPhone: from,
    body,
    receivedAt: new Date().toISOString(),
  });

  return { status: 200, enqueued: true, reason: "ok" };
}
