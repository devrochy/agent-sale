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
 *
 * Devuelve el `sid` del mensaje: que esta llamada no lance solo confirma
 * que Twilio *aceptó* el mensaje para entregarlo, no que llegó al
 * teléfono — la entrega real (o el rechazo, ej. fuera de la ventana de
 * 24h de WhatsApp) se resuelve después, de forma asíncrona. Quien necesite
 * confirmar la entrega real usa el `sid` con `getWhatsAppMessageStatus`
 * (ver src/jobs/dailyReport.ts para un caso real de esto — un envío
 * proactivo, sin turno de conversación en curso que lo valide).
 */
export async function sendWhatsAppMessage(
  to: string,
  body: string,
  mediaUrl?: string,
): Promise<string> {
  const message = await getClient().messages.create({
    from: env.twilioWhatsappNumber,
    to,
    body,
    ...(mediaUrl ? { mediaUrl: [mediaUrl] } : {}),
  });
  return message.sid;
}

export interface WhatsAppMessageStatus {
  status: string;
  errorCode: number | null;
}

/**
 * Estado real de entrega de un mensaje ya enviado (ver sendWhatsAppMessage).
 * `errorCode` 63016 es el caso más común en este proyecto: "fuera de la
 * ventana de 24h" — Twilio exige un Message Template aprobado para mandar
 * fuera de esa ventana, y este sistema todavía no implementa plantillas
 * (ver ADR-019, docs/fase-12-capacidades-proactivas-agente/).
 */
export async function getWhatsAppMessageStatus(sid: string): Promise<WhatsAppMessageStatus> {
  const message = await getClient().messages(sid).fetch();
  return { status: message.status, errorCode: message.errorCode };
}
