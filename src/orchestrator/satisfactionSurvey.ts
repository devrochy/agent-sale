import type { Logger } from "pino";
import { env } from "../config/env.js";
import { sendWhatsAppMessage } from "../gateway/sendMessage.js";
import { verifyDelivery } from "../jobs/verifyDelivery.js";
import { createReviewToken, withTransaction } from "../shared/db/index.js";
import { logger } from "../shared/observability/logger.js";
import { appendMessage } from "./memory.js";

const SURVEY_TEXT =
  "¡Gracias por tu compra! 🙏 ¿Cómo calificarías tu experiencia del 1 al 5? (5 = excelente)";

// Ventana para reconocer la respuesta de la encuesta como tal — no tiene
// relación con la ventana de 24h de WhatsApp (ADR-019, esa aplica a
// mensajes salientes fuera de turno; acá el mensaje entrante del cliente
// llega por el webhook normal, siempre disponible). Es solo para no
// quedar "esperando" una respuesta indefinidamente si el cliente nunca
// contesta.
const SURVEY_REPLY_WINDOW_HOURS = 48;

/**
 * Se llama desde `resolverConversacion` (src/advisor/handoffView.ts) justo
 * después de cerrar la conversación — best-effort, un fallo acá no debe
 * afectar el cierre en sí (que ya quedó confirmado en la base antes de
 * llamar a esta función).
 */
export async function sendSurveyOnClose(conversationId: string): Promise<void> {
  const surveyLogger = logger.child({ conversation_id: conversationId });
  try {
    const phone = await withTransaction(async (client) => {
      const conversation = await client.query<{ customer_id: string }>(
        `SELECT customer_id FROM conversations WHERE id = $1`,
        [conversationId],
      );
      const customerId = conversation.rows[0]?.customer_id;
      if (!customerId) {
        return null;
      }
      const customer = await client.query<{ phone_number: string }>(
        `SELECT phone_number FROM customers WHERE id = $1`,
        [customerId],
      );
      return customer.rows[0]?.phone_number ?? null;
    });
    if (!phone) {
      return;
    }

    const sid = await sendWhatsAppMessage(phone, SURVEY_TEXT);
    await withTransaction((client) =>
      client.query(`UPDATE conversations SET survey_sent_at = now() WHERE id = $1`, [
        conversationId,
      ]),
    );
    await appendMessage(conversationId, "outbound", "agent", SURVEY_TEXT);
    await verifyDelivery(sid, "Encuesta de satisfacción", surveyLogger);
  } catch (error) {
    surveyLogger.warn({ error }, "No se pudo enviar la encuesta de satisfacción");
  }
}

interface PendingSurveyRow {
  conversation_id: string;
}

async function findPendingSurvey(customerPhone: string): Promise<string | null> {
  return withTransaction(async (client) => {
    const result = await client.query<PendingSurveyRow>(
      `SELECT c.id AS conversation_id
       FROM conversations c
       JOIN customers cu ON cu.id = c.customer_id
       WHERE cu.phone_number = $1
         AND c.status = 'closed'
         AND c.survey_sent_at IS NOT NULL
         AND c.survey_reply_processed_at IS NULL
         AND c.survey_sent_at >= now() - interval '${SURVEY_REPLY_WINDOW_HOURS} hours'
       ORDER BY c.closed_at DESC
       LIMIT 1`,
      [customerPhone],
    );
    return result.rows[0]?.conversation_id ?? null;
  });
}

/** Primer dígito 1-5 en el texto — tolerante a "5 estrellas", "le doy un 4", etc. */
function parseRating(text: string): number | null {
  const match = text.match(/[1-5]/);
  return match ? Number(match[0]) : null;
}

/**
 * El link va a nuestra propia página de reseña (src/reviews/reviewView.ts),
 * nunca directo a una plataforma externa — así el texto que escribe el
 * cliente queda en agent-sale, disponible para análisis, y no depende de
 * si se configuró `settings.review_link` (ese link externo pasa a ser un
 * paso posterior *dentro* de la página, opcional).
 */
function buildThankYouText(score: number, reviewFormLink: string | null): string {
  if (score >= 4 && reviewFormLink) {
    return `¡Genial, gracias por tu calificación! 🎉 ¿Nos contás un poco más de tu experiencia? Nos ayuda muchísimo: ${reviewFormLink}`;
  }
  return "¡Gracias por tu calificación! 🙏 Vamos a seguir mejorando.";
}

function buildReviewFormLink(token: string): string {
  return `${new URL(env.publicWebhookUrl).origin}/resena/${token}`;
}

/**
 * Se llama desde `consumer.ts` (`processEntry`), antes de cualquier otro
 * procesamiento del mensaje entrante — es un efecto secundario NO
 * bloqueante: el mensaje del cliente sigue su curso normal hacia
 * `appendInbound`/el LLM después de esto, se llame o no haya calificación
 * reconocible. No intercepta ni descarta nada, para no arriesgarse a
 * tragarse un pedido real si el cliente responde "5, y de paso quiero
 * comprar otro casco".
 *
 * `survey_reply_processed_at` se marca siempre que se encuentra una
 * encuesta pendiente, haya o no calificación reconocible en el mensaje —
 * un solo intento por conversación cerrada, así no se revisan mensajes
 * futuros no relacionados como si fueran la respuesta de la encuesta.
 */
export async function tryCaptureSurveyReply(
  customerPhone: string,
  body: string,
  parentLogger: Logger,
): Promise<void> {
  const conversationId = await findPendingSurvey(customerPhone);
  if (!conversationId) {
    return;
  }

  const surveyLogger = parentLogger.child({ event: "orchestrator.encuesta_respondida" });
  const score = parseRating(body);

  try {
    await withTransaction((client) =>
      client.query(
        `UPDATE conversations SET survey_reply_processed_at = now()${score !== null ? ", satisfaction_score = $2" : ""} WHERE id = $1`,
        score !== null ? [conversationId, score] : [conversationId],
      ),
    );
  } catch (error) {
    surveyLogger.warn({ error }, "No se pudo marcar la encuesta como procesada");
    return;
  }

  if (score === null) {
    return;
  }

  try {
    const reviewFormLink =
      score >= 4 ? buildReviewFormLink(await createReviewToken(conversationId)) : null;
    const text = buildThankYouText(score, reviewFormLink);
    const sid = await sendWhatsAppMessage(customerPhone, text);
    await appendMessage(conversationId, "outbound", "agent", text);
    await verifyDelivery(sid, "Agradecimiento de encuesta", surveyLogger);
  } catch (error) {
    surveyLogger.warn({ error }, "No se pudo enviar el agradecimiento de la encuesta");
  }
}
