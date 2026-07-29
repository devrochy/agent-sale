import twilio from "twilio";
import { env } from "../config/env.js";

let client: twilio.Twilio | undefined;

function getClient(): twilio.Twilio {
  // Construcción diferida a propósito: el constructor de Twilio valida el
  // formato de accountSid (debe empezar con "AC") y lanza si no cumple.
  // Si se construyera al importar el módulo, cualquier valor de
  // desarrollo no realista (ver .env.example) tumbaría toda la app al
  // arrancar, no solo el envío real que sí se espera que falle sin
  // cuenta real de Twilio.
  client ??= twilio(env.twilioAccountSid, env.twilioAuthToken);
  return client;
}

/**
 * Envío saliente de la respuesta del agente. No pasa por la cola de
 * entrada (ver docs/fase-3-whatsapp-gateway/cola-mensajes.md, "mensajes
 * salientes") — es una llamada síncrona simple a la API de Twilio,
 * disparada por el orchestrator tras terminar un turno.
 */
export async function sendWhatsAppMessage(
  to: string,
  body: string,
  mediaUrl?: string,
): Promise<void> {
  await getClient().messages.create({
    from: env.twilioWhatsappNumber,
    to,
    body,
    ...(mediaUrl ? { mediaUrl: [mediaUrl] } : {}),
  });
}
