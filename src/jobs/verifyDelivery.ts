import type { Logger } from "pino";
import { getWhatsAppMessageStatus } from "../gateway/sendMessage.js";

// WhatsApp resuelve entrega/rechazo en segundos, no minutos (confirmado en
// QA real: date_updated ~2s después de date_created en un mensaje
// rechazado por estar fuera de la ventana de 24h) — este delay alcanza
// para detectar el caso más común de fallo silencioso sin frenar el job
// mucho tiempo. Son jobs de baja frecuencia (diario/cada hora, ver
// src/jobs/scheduler.ts), no un path sensible a latencia.
const DELIVERY_CHECK_DELAY_MS = 4000;

/**
 * Confirma la entrega real de un mensaje proactivo ya enviado (ver
 * sendWhatsAppMessage en src/gateway/sendMessage.ts — que no lance solo
 * significa que Twilio lo aceptó, no que llegó). Compartida entre todos
 * los jobs de src/jobs/ que mandan WhatsApp fuera de un turno de
 * conversación (Reporte diario, Cazador de ventas) — mismo hallazgo real
 * de QA en ambos: un envío fuera de la ventana de 24h de WhatsApp queda
 * `undelivered` en silencio si nadie consulta el estado después.
 *
 * `label` identifica el tipo de mensaje en los logs (ej. "Reporte diario",
 * "Mensaje de reenganche") — un fallo acá (no poder consultar el estado)
 * no es lo mismo que un fallo de envío: el mensaje sí se mandó, solo no se
 * pudo verificar, así que se loguea distinto para no confundir ambos casos
 * en Loki/Grafana.
 */
export async function verifyDelivery(sid: string, label: string, jobLogger: Logger): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, DELIVERY_CHECK_DELAY_MS));
  try {
    const { status, errorCode } = await getWhatsAppMessageStatus(sid);
    if (status === "undelivered" || status === "failed") {
      jobLogger.warn(
        { sid, status, errorCode },
        `${label} rechazado por WhatsApp — probablemente fuera de la ventana de 24h (errorCode 63016) o el destinatario nunca inició conversación con el bot`,
      );
    } else {
      jobLogger.info({ sid, status }, `${label} enviado`);
    }
  } catch (error) {
    jobLogger.warn(
      { sid, error },
      `${label} enviado, pero no se pudo confirmar el estado de entrega`,
    );
  }
}
