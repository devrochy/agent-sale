import { randomBytes } from "node:crypto";
import { pool } from "./pool.js";

export interface ReviewTokenLookup {
  tenantId: string;
  conversationId: string;
}

/**
 * Único punto que consulta/escribe `review_tokens` con el pool crudo, sin
 * pasar por `withTenant` — misma razón que `handoffTokenDirectory.ts`:
 * resolver el token es el paso anterior a poder abrir una sesión con
 * `app.tenant_id` (ver migrations/0029_review_tokens.cjs).
 */
export async function createReviewToken(tenantId: string, conversationId: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await pool.query(
    `INSERT INTO review_tokens (token, tenant_id, conversation_id) VALUES ($1, $2, $3)`,
    [token, tenantId, conversationId],
  );
  return token;
}

export async function resolveReviewToken(token: string): Promise<ReviewTokenLookup | null> {
  const result = await pool.query<{ tenant_id: string; conversation_id: string }>(
    `SELECT tenant_id, conversation_id FROM review_tokens WHERE token = $1`,
    [token],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { tenantId: row.tenant_id, conversationId: row.conversation_id };
}
