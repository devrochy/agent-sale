import { randomBytes } from "node:crypto";
import { pool } from "./pool.js";

export interface HandoffTokenLookup {
  tenantId: string;
  handoffId: string;
  humanAgentId: string | null;
}

/**
 * Único punto que consulta/escribe `handoff_tokens` con el pool crudo,
 * sin pasar por `withTenant` — por la misma razón que
 * `findTenantIdByWhatsappNumber`: resolver el token es el paso anterior a
 * poder abrir una sesión con `app.tenant_id` (ver migrations/0015_handoff_tokens.cjs).
 */
export async function createHandoffToken(
  tenantId: string,
  handoffId: string,
  humanAgentId: string | null,
): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await pool.query(
    `INSERT INTO handoff_tokens (token, tenant_id, handoff_id, human_agent_id) VALUES ($1, $2, $3, $4)`,
    [token, tenantId, handoffId, humanAgentId],
  );
  return token;
}

export async function resolveHandoffToken(token: string): Promise<HandoffTokenLookup | null> {
  const result = await pool.query<{
    tenant_id: string;
    handoff_id: string;
    human_agent_id: string | null;
  }>(`SELECT tenant_id, handoff_id, human_agent_id FROM handoff_tokens WHERE token = $1`, [token]);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { tenantId: row.tenant_id, handoffId: row.handoff_id, humanAgentId: row.human_agent_id };
}
