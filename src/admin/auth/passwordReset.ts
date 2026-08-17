import { createHash, randomBytes } from "node:crypto";

import { pool } from "../../shared/db/pool.js";
import { withTransaction } from "../../shared/db/withTransaction.js";

/**
 * Tokens de recuperación de contraseña del panel (ver
 * docs/fase-11-panel-admin-dashboard/contrasena.md y
 * migrations/0055_admin_password_resets.cjs).
 *
 * El token en claro existe una sola vez: se genera acá, se manda por
 * WhatsApp dentro del enlace y no se guarda en ningún lado. La tabla
 * guarda su SHA-256, así que ni un volcado de la base ni un backup viejo
 * alcanzan para restablecerle la contraseña a nadie.
 */

/**
 * 30 minutos. El enlace llega por WhatsApp a un celular que a esa altura
 * está en la mano de quien lo pidió, así que no hace falta la ventana larga
 * que se le daría a un correo que se lee al día siguiente. Si expira, pedir
 * otro cuesta un formulario.
 */
const RESET_TTL_MS = 30 * 60 * 1000;

/**
 * 32 bytes — 256 bits, el mismo generador que `createAdminSession` con más
 * margen, porque este token viaja en una URL que puede quedar en el
 * historial del navegador y en un chat de WhatsApp.
 */
function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Emite un token para `adminId` e **invalida los que ya tuviera**. Sin ese
 * borrado, pedir el enlace tres veces dejaría tres enlaces vivos y el más
 * viejo —el que quedó en un mensaje reenviado— seguiría sirviendo. Devuelve
 * el token en claro; es la única vez que se puede leer.
 */
export async function createPasswordResetToken(adminId: string): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM admin_password_resets WHERE admin_id = $1`, [adminId]);
    await client.query(
      `INSERT INTO admin_password_resets (token_hash, admin_id, expires_at) VALUES ($1, $2, $3)`,
      [hashToken(token), adminId, expiresAt],
    );
  });
  return token;
}

/**
 * `null` si el token no existe, ya venció o ya se usó — los tres casos se
 * responden igual en la UI, porque distinguirlos solo le sirve a quien está
 * probando tokens a ver cuál pega.
 *
 * No marca nada: esto corre al abrir el enlace, antes de que la persona
 * escriba la contraseña nueva. Consumirlo acá haría que el enlace muriera
 * con solo mirarlo.
 */
export async function resolvePasswordResetToken(token: string): Promise<{ adminId: string } | null> {
  const result = await pool.query<{ admin_id: string }>(
    `SELECT admin_id FROM admin_password_resets
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  return row ? { adminId: row.admin_id } : null;
}

/**
 * Marca el token como usado y devuelve a quién pertenecía, en una sola
 * sentencia: el `used_at IS NULL` del WHERE es lo que impide que dos envíos
 * simultáneos del mismo formulario ganen los dos. El caller cambia la
 * contraseña solo si esto devolvió un admin.
 */
export async function consumePasswordResetToken(token: string): Promise<{ adminId: string } | null> {
  const result = await pool.query<{ admin_id: string }>(
    `UPDATE admin_password_resets
       SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING admin_id`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  return row ? { adminId: row.admin_id } : null;
}
