import { randomBytes } from "node:crypto";
import { pool } from "../../shared/db/pool.js";

// 7 días — sin exponerlo como variable de entorno todavía, nadie pidió
// que fuera configurable (mismo criterio de no diseñar de más que ya usa
// el proyecto, ver ADR-016). Se puede subir a config si hace falta.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AdminSessionLookup {
  adminId: string;
  tenantId: string;
}

/**
 * Único punto que consulta/escribe `admin_sessions` con el pool crudo, sin
 * pasar por `withTenant` — misma razón que review_tokens/handoff_tokens
 * (ver migrations/0033_admins.cjs): resolver el token de sesión es el paso
 * anterior a poder abrir una sesión con `app.tenant_id` seteado, así que
 * no puede depender de RLS.
 */
export async function createAdminSession(adminId: string, tenantId: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO admin_sessions (token, admin_id, tenant_id, expires_at) VALUES ($1, $2, $3, $4)`,
    [token, adminId, tenantId, expiresAt],
  );
  return token;
}

/**
 * Resuelve el token a admin_id/tenant_id — NO valida `admins.active`
 * acá (esa tabla sí tiene RLS, ver adminsDirectory.ts). El caller siempre
 * debe encadenar un chequeo de `active` contra `admins` antes de confiar
 * en la sesión (ver ADR-025: la revocación es por chequeo en cada
 * request, no por borrado de filas de esta tabla).
 */
export async function resolveAdminSession(token: string): Promise<AdminSessionLookup | null> {
  const result = await pool.query<{ admin_id: string; tenant_id: string }>(
    `SELECT admin_id, tenant_id FROM admin_sessions WHERE token = $1 AND expires_at > now()`,
    [token],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { adminId: row.admin_id, tenantId: row.tenant_id };
}

export async function deleteAdminSession(token: string): Promise<void> {
  await pool.query(`DELETE FROM admin_sessions WHERE token = $1`, [token]);
}
