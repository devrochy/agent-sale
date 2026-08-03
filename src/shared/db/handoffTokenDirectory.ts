import { randomBytes } from "node:crypto";
import { pool } from "./pool.js";

export interface HandoffTokenLookup {
  handoffId: string;
  humanAgentId: string | null;
}

/**
 * Único punto que consulta/escribe `handoff_tokens` con el pool crudo,
 * sin pasar por `withTransaction` — no hay ninguna razón técnica para
 * abrir una transacción acá, es un insert/select puntual (ver
 * migrations/0015_handoff_tokens.cjs).
 */
export async function createHandoffToken(
  handoffId: string,
  humanAgentId: string | null,
): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await pool.query(`INSERT INTO handoff_tokens (token, handoff_id, human_agent_id) VALUES ($1, $2, $3)`, [
    token,
    handoffId,
    humanAgentId,
  ]);
  return token;
}

export async function resolveHandoffToken(token: string): Promise<HandoffTokenLookup | null> {
  const result = await pool.query<{ handoff_id: string; human_agent_id: string | null }>(
    `SELECT handoff_id, human_agent_id FROM handoff_tokens WHERE token = $1`,
    [token],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { handoffId: row.handoff_id, humanAgentId: row.human_agent_id };
}
