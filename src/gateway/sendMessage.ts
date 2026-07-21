import twilio from "twilio";
import { env } from "../config/env.js";

const client = twilio(env.twilioAccountSid, env.twilioAuthToken);

/**
 * Envío saliente de la respuesta del agente. No pasa por la cola de
 * entrada (ver docs/fase-3-whatsapp-gateway/cola-mensajes.md, "mensajes
 * salientes") — es una llamada síncrona simple a la API de Twilio,
 * disparada por el orchestrator tras terminar un turno.
 */
export async function sendWhatsAppMessage(to: string, body: string): Promise<void> {
  await client.messages.create({
    from: env.twilioWhatsappNumber,
    to,
    body,
  });
}
