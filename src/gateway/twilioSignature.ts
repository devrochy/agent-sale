import twilio from "twilio";
import { env } from "../config/env.js";

/**
 * Verificación de firma X-Twilio-Signature (ver
 * docs/fase-3-whatsapp-gateway/webhook-contrato.md): usa el validador
 * oficial del SDK en vez de reimplementar el HMAC a mano, para evitar
 * errores sutiles de encoding/orden de parámetros.
 */
export function verifyTwilioSignature(
  params: Record<string, string>,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) {
    return false;
  }
  return twilio.validateRequest(env.twilioAuthToken, signatureHeader, env.publicWebhookUrl, params);
}
