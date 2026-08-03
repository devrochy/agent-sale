import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../../src/gateway/server.js";
import {
  renderReviewForm,
  shareReviewPublicly,
  submitReview,
} from "../../../src/reviews/reviewView.js";
import { createReviewToken } from "../../../src/shared/db/reviewTokenDirectory.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
const app = await buildServer();

const REVIEW_LINK = "https://ejemplo.com/review";
let settingsId: string;
let phoneCounter = 0;

async function seedConversationWithScore(score: number | null): Promise<string> {
  phoneCounter += 1;
  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (phone_number) VALUES ($1) RETURNING id`,
    [`whatsapp:+57303000${String(phoneCounter).padStart(4, "0")}`],
  );
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id, status, closed_at, satisfaction_score)
     VALUES ($1, 'closed', now(), $2) RETURNING id`,
    [customer.rows[0]!.id, score],
  );
  return conversation.rows[0]!.id;
}

beforeAll(async () => {
  await app.ready();

  const settings = await adminPool.query<{ id: string }>(
    `INSERT INTO settings (name, review_link) VALUES ('Review View Test', $1) RETURNING id`,
    [REVIEW_LINK],
  );
  settingsId = settings.rows[0]!.id;
});

afterAll(async () => {
  // Todos los clientes de este archivo usan el prefijo whatsapp:+57303000
  // (ver seedConversationWithScore) — patrón exclusivo de este archivo, no
  // colisiona con los números de otros test files.
  const phonePattern = "whatsapp:+57303000%";
  await adminPool.query(
    `DELETE FROM reviews WHERE conversation_id IN (
       SELECT c.id FROM conversations c JOIN customers cu ON cu.id = c.customer_id
       WHERE cu.phone_number LIKE $1
     )`,
    [phonePattern],
  );
  await adminPool.query(
    `DELETE FROM review_tokens WHERE conversation_id IN (
       SELECT c.id FROM conversations c JOIN customers cu ON cu.id = c.customer_id
       WHERE cu.phone_number LIKE $1
     )`,
    [phonePattern],
  );
  await adminPool.query(
    `DELETE FROM conversations WHERE customer_id IN (SELECT id FROM customers WHERE phone_number LIKE $1)`,
    [phonePattern],
  );
  await adminPool.query(`DELETE FROM customers WHERE phone_number LIKE $1`, [phonePattern]);
  await adminPool.query(`DELETE FROM settings WHERE id = $1`, [settingsId]);
  await app.close();
  await adminPool.end();
  await appPool.end();
});

describe("renderReviewForm", () => {
  it("token inválido devuelve 404", async () => {
    const result = await renderReviewForm("token-invalido");
    expect(result.status).toBe(404);
  });

  it("muestra el form si no hay reseña previa", async () => {
    const conversationId = await seedConversationWithScore(5);
    const token = await createReviewToken(conversationId);

    const result = await renderReviewForm(token);

    expect(result.status).toBe(200);
    expect(result.html).toContain("<form");
    expect(result.html).toContain(`action="/resena/${token}"`);
  });
});

describe("submitReview", () => {
  it("guarda la reseña con el score copiado de la conversación", async () => {
    const conversationId = await seedConversationWithScore(5);
    const token = await createReviewToken(conversationId);

    const result = await submitReview(token, "Excelente atención, muy rápidos.");

    expect(result.status).toBe(200);
    const row = await adminPool.query<{ score: number; review_text: string }>(
      `SELECT score, review_text FROM reviews WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(row.rows[0]!.score).toBe(5);
    expect(row.rows[0]!.review_text).toBe("Excelente atención, muy rápidos.");
  });

  it("texto vacío no guarda nada y vuelve a mostrar el form con el error", async () => {
    const conversationId = await seedConversationWithScore(5);
    const token = await createReviewToken(conversationId);

    const result = await submitReview(token, "   ");

    expect(result.status).toBe(200);
    expect(result.html).toContain("Escribinos algo");
    const row = await adminPool.query(`SELECT count(*) FROM reviews WHERE conversation_id = $1`, [
      conversationId,
    ]);
    expect(Number(row.rows[0]!.count)).toBe(0);
  });

  it("una segunda visita ya no muestra el form (idempotente)", async () => {
    const conversationId = await seedConversationWithScore(5);
    const token = await createReviewToken(conversationId);
    await submitReview(token, "Primera reseña");

    const second = await renderReviewForm(token);

    expect(second.status).toBe(200);
    expect(second.html).not.toContain("<form");
    expect(second.html).toContain("¡Gracias");
  });

  it("un segundo envío no duplica la reseña (constraint única en conversation_id)", async () => {
    const conversationId = await seedConversationWithScore(5);
    const token = await createReviewToken(conversationId);
    await submitReview(token, "Primera reseña");

    await submitReview(token, "Segundo intento");

    const rows = await adminPool.query<{ review_text: string }>(
      `SELECT review_text FROM reviews WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.review_text).toBe("Primera reseña");
  });
});

describe("shareReviewPublicly", () => {
  it("sin review_link configurado devuelve 404", async () => {
    await adminPool.query(`UPDATE settings SET review_link = NULL WHERE id = $1`, [settingsId]);
    try {
      const conversationId = await seedConversationWithScore(5);
      const token = await createReviewToken(conversationId);
      await submitReview(token, "Buena experiencia");

      const result = await shareReviewPublicly(token);

      expect(result.status).toBe(404);
    } finally {
      await adminPool.query(`UPDATE settings SET review_link = $1 WHERE id = $2`, [
        REVIEW_LINK,
        settingsId,
      ]);
    }
  });

  it("con review_link configurado redirige y marca shared_publicly", async () => {
    const conversationId = await seedConversationWithScore(5);
    const token = await createReviewToken(conversationId);
    await submitReview(token, "Buena experiencia");

    const result = await shareReviewPublicly(token);

    expect(result.status).toBe(302);
    expect(result.redirectUrl).toBe(REVIEW_LINK);
    const row = await adminPool.query<{ shared_publicly: boolean }>(
      `SELECT shared_publicly FROM reviews WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(row.rows[0]!.shared_publicly).toBe(true);
  });
});

describe("rutas HTTP /resena", () => {
  it("GET /resena/:token responde 200 con el form", async () => {
    const conversationId = await seedConversationWithScore(5);
    const token = await createReviewToken(conversationId);

    const response = await app.inject({ method: "GET", url: `/resena/${token}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<form");
  });

  it("GET /resena/:token con token inválido responde 404", async () => {
    const response = await app.inject({ method: "GET", url: "/resena/no-existe" });
    expect(response.statusCode).toBe(404);
  });

  it("POST /resena/:token guarda la reseña", async () => {
    const conversationId = await seedConversationWithScore(5);
    const token = await createReviewToken(conversationId);

    const response = await app.inject({
      method: "POST",
      url: `/resena/${token}`,
      payload: `review_text=${encodeURIComponent("Muy buena atención")}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(response.statusCode).toBe(200);
    const row = await adminPool.query<{ review_text: string }>(
      `SELECT review_text FROM reviews WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(row.rows[0]!.review_text).toBe("Muy buena atención");
  });

  it("GET /resena/:token/compartir redirige (302) cuando hay link configurado", async () => {
    const conversationId = await seedConversationWithScore(5);
    const token = await createReviewToken(conversationId);
    await submitReview(token, "Buena experiencia");

    const response = await app.inject({ method: "GET", url: `/resena/${token}/compartir` });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(REVIEW_LINK);
  });
});
