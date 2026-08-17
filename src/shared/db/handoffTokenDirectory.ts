import { randomBytes } from "node:crypto";
import { pool } from "./pool.js";

export interface HandoffTokenLookup {
  handoffId: string;
}

/**
 * Único punto que consulta/escribe `handoff_tokens` con el pool crudo,
 * sin pasar por `withTransaction` — no hay ninguna razón técnica para
 * abrir una transacción acá, es un insert/select puntual (ver
 * migrations/0015_handoff_tokens.cjs). Desde Fase 18/ADR-028 el token solo
 * resuelve la vista de solo lectura — ya no queda atado a un asesor.
 */
export async function createHandoffToken(handoffId: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await pool.query(`INSERT INTO handoff_tokens (token, handoff_id) VALUES ($1, $2)`, [token, handoffId]);
  return token;
}

export async function resolveHandoffToken(token: string): Promise<HandoffTokenLookup | null> {
  const result = await pool.query<{ handoff_id: string }>(
    `SELECT handoff_id FROM handoff_tokens WHERE token = $1`,
    [token],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { handoffId: row.handoff_id };
}
