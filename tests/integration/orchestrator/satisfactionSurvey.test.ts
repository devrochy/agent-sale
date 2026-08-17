import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendToConversation: vi.fn(),
  getWhatsAppMessageStatus: vi.fn(),
}));

import { sendToConversation, getWhatsAppMessageStatus } from "../../../src/gateway/sendMessage.js";
import { tryCaptureSurveyReply } from "../../../src/orchestrator/satisfactionSurvey.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { logger } from "../../../src/shared/observability/logger.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const PHONES = {
  conCalificacion: "whatsapp:+573020000001",
  sinCalificacion: "whatsapp:+573020000002",
  sinEncuestaPendiente: "whatsapp:+573020000003",
  yaProcesada: "whatsapp:+573020000004",
  scoreAlto: "whatsapp:+573020000005",
  scoreBajo: "whatsapp:+573020000006",
  ventanaVencida: "whatsapp:+573020000007",
};

async function seedConversation(
  phone: string,
  opts: {
    surveyHoursAgo: number | null;
    alreadyProcessed?: boolean;
    existingScore?: number;
  },
): Promise<string> {
  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id) VALUES ($1) RETURNING id`,
    [phone],
  );
  const surveySentAt =
    opts.surveyHoursAgo === null
      ? null
      : new Date(Date.now() - opts.surveyHoursAgo * 60 * 60 * 1000);
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations
       (customer_id, status, closed_at, survey_sent_at, survey_reply_processed_at, satisfaction_score)
     VALUES ($1, 'closed', now(), $2, $3, $4)
     RETURNING id`,
    [
      customer.rows[0]!.id,
      surveySentAt,
      opts.alreadyProcessed ? new Date() : null,
      opts.existingScore ?? null,
    ],
  );
  return conversation.rows[0]!.id;
}

afterEach(() => {
  vi.mocked(sendToConversation).mockReset();
  vi.mocked(getWhatsAppMessageStatus).mockReset();
});

afterAll(async () => {
  const phones = Object.values(PHONES);
  await adminPool.query(
    `DELETE FROM review_tokens WHERE conversation_id IN (
       SELECT c.id FROM conversations c JOIN customers cu ON cu.id = c.customer_id
       WHERE cu.external_id = ANY($1)
     )`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM messages WHERE conversation_id IN (
       SELECT c.id FROM conversations c JOIN customers cu ON cu.id = c.customer_id
       WHERE cu.external_id = ANY($1)
     )`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM conversations WHERE customer_id IN (SELECT id FROM customers WHERE external_id = ANY($1))`,
    [phones],
  );
  await adminPool.query(`DELETE FROM customers WHERE external_id = ANY($1)`, [phones]);
  await adminPool.end();
  await appPool.end();
});

describe("tryCaptureSurveyReply", () => {
  beforeEach(() => {
    vi.mocked(sendToConversation).mockResolvedValue("SM_TEST_SID");
    vi.mocked(getWhatsAppMessageStatus).mockResolvedValue({ status: "delivered", errorCode: null });
  });

  it("calificación reconocible: guarda el score, marca procesado y agradece con link a la reseña propia (score alto)", async () => {
    const conversationId = await seedConversation(PHONES.conCalificacion, { surveyHoursAgo: 2 });

    await tryCaptureSurveyReply(PHONES.conCalificacion, "whatsapp", "5, todo excelente", logger);

    const row = await adminPool.query<{
      satisfaction_score: number;
      survey_reply_processed_at: Date;
    }>(`SELECT satisfaction_score, survey_reply_processed_at FROM conversations WHERE id = $1`, [
      conversationId,
    ]);
    expect(row.rows[0]!.satisfaction_score).toBe(5);
    expect(row.rows[0]!.survey_reply_processed_at).not.toBeNull();

    // El link va a nuestra propia página de reseña (/resena/:token), no
    // directo a la plataforma externa — ver satisfactionSurvey.ts.
    expect(sendToConversation).toHaveBeenCalledWith(
      conversationId,
      expect.stringContaining("/resena/"),
    );
    const [, text] = vi.mocked(sendToConversation).mock.calls[0]!;
    const token = text.match(/\/resena\/(\S+)/)?.[1];
    expect(token).toBeTruthy();
    const tokenRow = await adminPool.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM review_tokens WHERE token = $1`,
      [token],
    );
    expect(tokenRow.rows[0]!.conversation_id).toBe(conversationId);
  });

  it("sin calificación reconocible: marca procesado pero no manda nada", async () => {
    const conversationId = await seedConversation(PHONES.sinCalificacion, { surveyHoursAgo: 2 });

    await tryCaptureSurveyReply(PHONES.sinCalificacion, "whatsapp", "Hola, tengo otra pregunta", logger);

    const row = await adminPool.query<{
      satisfaction_score: number | null;
      survey_reply_processed_at: Date;
    }>(`SELECT satisfaction_score, survey_reply_processed_at FROM conversations WHERE id = $1`, [
      conversationId,
    ]);
    expect(row.rows[0]!.satisfaction_score).toBeNull();
    expect(row.rows[0]!.survey_reply_processed_at).not.toBeNull();
    expect(sendToConversation).not.toHaveBeenCalled();
  });

  it("sin encuesta pendiente: no hace nada", async () => {
    await adminPool.query(`INSERT INTO customers (external_id) VALUES ($1)`, [
      PHONES.sinEncuestaPendiente,
    ]);

    await tryCaptureSurveyReply(PHONES.sinEncuestaPendiente, "whatsapp", "5", logger);

    expect(sendToConversation).not.toHaveBeenCalled();
  });

  it("encuesta ya procesada: no se reprocesa ni se pisa el score existente", async () => {
    const conversationId = await seedConversation(PHONES.yaProcesada, {
      surveyHoursAgo: 2,
      alreadyProcessed: true,
      existingScore: 3,
    });

    await tryCaptureSurveyReply(PHONES.yaProcesada, "whatsapp", "5", logger);

    const row = await adminPool.query<{ satisfaction_score: number }>(
      `SELECT satisfaction_score FROM conversations WHERE id = $1`,
      [conversationId],
    );
    expect(row.rows[0]!.satisfaction_score).toBe(3);
    expect(sendToConversation).not.toHaveBeenCalled();
  });

  it("score alto: manda el link de reseña propio (independiente de cualquier link externo configurado)", async () => {
    // satisfactionSurvey.ts nunca lee settings.review_link — el link
    // externo (Google) es un paso posterior opcional DENTRO de la página
    // de reseña, no una condición para ofrecer la reseña interna.
    const conversationId = await seedConversation(PHONES.scoreAlto, { surveyHoursAgo: 2 });

    await tryCaptureSurveyReply(PHONES.scoreAlto, "whatsapp", "5", logger);

    expect(sendToConversation).toHaveBeenCalledWith(
      conversationId,
      expect.stringContaining("/resena/"),
    );
  });

  it("score bajo: agradece sin link", async () => {
    const conversationId = await seedConversation(PHONES.scoreBajo, { surveyHoursAgo: 2 });

    await tryCaptureSurveyReply(PHONES.scoreBajo, "whatsapp", "2", logger);

    expect(sendToConversation).toHaveBeenCalledWith(conversationId, expect.any(String));
    const [, text] = vi.mocked(sendToConversation).mock.calls[0]!;
    expect(text).not.toContain("http");
  });

  it("ventana de 48h vencida: no se captura", async () => {
    await seedConversation(PHONES.ventanaVencida, { surveyHoursAgo: 50 });

    await tryCaptureSurveyReply(PHONES.ventanaVencida, "whatsapp", "5", logger);

    expect(sendToConversation).not.toHaveBeenCalled();
  });
});
