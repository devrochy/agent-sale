import { randomBytes } from "node:crypto";
import { pool } from "./pool.js";

/**
 * Único punto que consulta/escribe `review_tokens` con el pool crudo, sin
 * pasar por `withTransaction` — insert/select puntual (ver
 * migrations/0029_review_tokens.cjs).
 */
export async function createReviewToken(conversationId: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await pool.query(`INSERT INTO review_tokens (token, conversation_id) VALUES ($1, $2)`, [
    token,
    conversationId,
  ]);
  return token;
}

export async function resolveReviewToken(token: string): Promise<{ conversationId: string } | null> {
  const result = await pool.query<{ conversation_id: string }>(
    `SELECT conversation_id FROM review_tokens WHERE token = $1`,
    [token],
  );
  const row = result.rows[0];
  return row ? { conversationId: row.conversation_id } : null;
}
