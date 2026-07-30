import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  getWhatsAppMessageStatus: vi.fn(),
}));

import { sendWhatsAppMessage, getWhatsAppMessageStatus } from "../../../src/gateway/sendMessage.js";
import { tryCaptureSurveyReply } from "../../../src/orchestrator/satisfactionSurvey.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { logger } from "../../../src/shared/observability/logger.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let tenantConLink: string;
let tenantSinLink: string;

const PHONES = {
  conCalificacion: "whatsapp:+573020000001",
  sinCalificacion: "whatsapp:+573020000002",
  sinEncuestaPendiente: "whatsapp:+573020000003",
  yaProcesada: "whatsapp:+573020000004",
  scoreAltoSinLink: "whatsapp:+573020000005",
  scoreBajo: "whatsapp:+573020000006",
  ventanaVencida: "whatsapp:+573020000007",
};

async function seedConversation(
  tenantId: string,
  phone: string,
  opts: {
    surveyHoursAgo: number | null;
    alreadyProcessed?: boolean;
    existingScore?: number;
  },
): Promise<string> {
  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, phone_number) VALUES ($1, $2) RETURNING id`,
    [tenantId, phone],
  );
  const surveySentAt =
    opts.surveyHoursAgo === null
      ? null
      : new Date(Date.now() - opts.surveyHoursAgo * 60 * 60 * 1000);
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations
       (tenant_id, customer_id, status, closed_at, survey_sent_at, survey_reply_processed_at, satisfaction_score)
     VALUES ($1, $2, 'closed', now(), $3, $4, $5)
     RETURNING id`,
    [
      tenantId,
      customer.rows[0]!.id,
      surveySentAt,
      opts.alreadyProcessed ? new Date() : null,
      opts.existingScore ?? null,
    ],
  );
  return conversation.rows[0]!.id;
}

beforeAll(async () => {
  const a = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name, review_link) VALUES ('Encuesta Test Con Link', 'https://ejemplo.com/review') RETURNING id`,
  );
  tenantConLink = a.rows[0]!.id;
  const b = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Encuesta Test Sin Link') RETURNING id`,
  );
  tenantSinLink = b.rows[0]!.id;
});

afterEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(getWhatsAppMessageStatus).mockReset();
});

afterAll(async () => {
  const tenants = [tenantConLink, tenantSinLink];
  await adminPool.query(`DELETE FROM review_tokens WHERE tenant_id = ANY($1)`, [tenants]);
  await adminPool.query(`DELETE FROM messages WHERE tenant_id = ANY($1)`, [tenants]);
  await adminPool.query(`DELETE FROM conversations WHERE tenant_id = ANY($1)`, [tenants]);
  await adminPool.query(`DELETE FROM customers WHERE tenant_id = ANY($1)`, [tenants]);
  await adminPool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenants]);
  await adminPool.end();
  await appPool.end();
});

describe("tryCaptureSurveyReply", () => {
  beforeEach(() => {
    vi.mocked(sendWhatsAppMessage).mockResolvedValue("SM_TEST_SID");
    vi.mocked(getWhatsAppMessageStatus).mockResolvedValue({ status: "delivered", errorCode: null });
  });

  it("calificación reconocible: guarda el score, marca procesado y agradece con link a la reseña propia (score alto)", async () => {
    const conversationId = await seedConversation(tenantConLink, PHONES.conCalificacion, {
      surveyHoursAgo: 2,
    });

    await tryCaptureSurveyReply(tenantConLink, PHONES.conCalificacion, "5, todo excelente", logger);

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
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      PHONES.conCalificacion,
      expect.stringContaining("/resena/"),
    );
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0]!;
    const token = text.match(/\/resena\/(\S+)/)?.[1];
    expect(token).toBeTruthy();
    const tokenRow = await adminPool.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM review_tokens WHERE token = $1`,
      [token],
    );
    expect(tokenRow.rows[0]!.conversation_id).toBe(conversationId);
  });

  it("sin calificación reconocible: marca procesado pero no manda nada", async () => {
    const conversationId = await seedConversation(tenantConLink, PHONES.sinCalificacion, {
      surveyHoursAgo: 2,
    });

    await tryCaptureSurveyReply(
      tenantConLink,
      PHONES.sinCalificacion,
      "Hola, tengo otra pregunta",
      logger,
    );

    const row = await adminPool.query<{
      satisfaction_score: number | null;
      survey_reply_processed_at: Date;
    }>(`SELECT satisfaction_score, survey_reply_processed_at FROM conversations WHERE id = $1`, [
      conversationId,
    ]);
    expect(row.rows[0]!.satisfaction_score).toBeNull();
    expect(row.rows[0]!.survey_reply_processed_at).not.toBeNull();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("sin encuesta pendiente: no hace nada", async () => {
    await adminPool.query(`INSERT INTO customers (tenant_id, phone_number) VALUES ($1, $2)`, [
      tenantConLink,
      PHONES.sinEncuestaPendiente,
    ]);

    await tryCaptureSurveyReply(tenantConLink, PHONES.sinEncuestaPendiente, "5", logger);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("encuesta ya procesada: no se reprocesa ni se pisa el score existente", async () => {
    const conversationId = await seedConversation(tenantConLink, PHONES.yaProcesada, {
      surveyHoursAgo: 2,
      alreadyProcessed: true,
      existingScore: 3,
    });

    await tryCaptureSurveyReply(tenantConLink, PHONES.yaProcesada, "5", logger);

    const row = await adminPool.query<{ satisfaction_score: number }>(
      `SELECT satisfaction_score FROM conversations WHERE id = $1`,
      [conversationId],
    );
    expect(row.rows[0]!.satisfaction_score).toBe(3);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("score alto sin review_link EXTERNO configurado: igual manda el link de reseña propio", async () => {
    // El link externo (Google) es un paso posterior opcional DENTRO de la
    // página de reseña, no una condición para ofrecer la reseña interna.
    await seedConversation(tenantSinLink, PHONES.scoreAltoSinLink, { surveyHoursAgo: 2 });

    await tryCaptureSurveyReply(tenantSinLink, PHONES.scoreAltoSinLink, "5", logger);

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      PHONES.scoreAltoSinLink,
      expect.stringContaining("/resena/"),
    );
  });

  it("score bajo: agradece sin link aunque el tenant lo tenga configurado", async () => {
    await seedConversation(tenantConLink, PHONES.scoreBajo, { surveyHoursAgo: 2 });

    await tryCaptureSurveyReply(tenantConLink, PHONES.scoreBajo, "2", logger);

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONES.scoreBajo, expect.any(String));
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0]!;
    expect(text).not.toContain("http");
  });

  it("ventana de 48h vencida: no se captura", async () => {
    await seedConversation(tenantConLink, PHONES.ventanaVencida, { surveyHoursAgo: 50 });

    await tryCaptureSurveyReply(tenantConLink, PHONES.ventanaVencida, "5", logger);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });
});
