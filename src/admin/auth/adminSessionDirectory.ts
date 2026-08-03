import { randomBytes } from "node:crypto";
import { pool } from "../../shared/db/pool.js";

// 7 días — sin exponerlo como variable de entorno todavía, nadie pidió
// que fuera configurable (mismo criterio de no diseñar de más que ya usa
// el proyecto, ver ADR-016). Se puede subir a config si hace falta.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Único punto que consulta/escribe `admin_sessions` con el pool crudo, sin
 * pasar por `withTransaction` — insert/select puntual, no hay ninguna
 * razón técnica para abrir una transacción acá.
 */
export async function createAdminSession(adminId: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(`INSERT INTO admin_sessions (token, admin_id, expires_at) VALUES ($1, $2, $3)`, [
    token,
    adminId,
    expiresAt,
  ]);
  return token;
}

/**
 * Resuelve el token a admin_id — NO valida `admins.active` acá (ver
 * adminsDirectory.ts). El caller siempre debe encadenar un chequeo de
 * `active` contra `admins` antes de confiar en la sesión (ver ADR-025: la
 * revocación es por chequeo en cada request, no por borrado de filas de
 * esta tabla).
 */
export async function resolveAdminSession(token: string): Promise<{ adminId: string } | null> {
  const result = await pool.query<{ admin_id: string }>(
    `SELECT admin_id FROM admin_sessions WHERE token = $1 AND expires_at > now()`,
    [token],
  );
  const row = result.rows[0];
  return row ? { adminId: row.admin_id } : null;
}

export async function deleteAdminSession(token: string): Promise<void> {
  await pool.query(`DELETE FROM admin_sessions WHERE token = $1`, [token]);
}
