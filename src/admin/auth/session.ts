import {
  createAdminSession,
  deleteAdminSession,
  resolveAdminSession,
} from "./adminSessionDirectory.js";
import { findAdminByEmail, getAdminById, type AdminRecord } from "./adminsDirectory.js";
import { verifyPassword } from "./passwordHash.js";

/** Credenciales inválidas y cuenta desactivada devuelven lo mismo (null) — no se filtra cuál de los dos casos fue, mismo criterio que verifyPassword. */
export async function login(
  tenantId: string,
  email: string,
  password: string,
): Promise<string | null> {
  const admin = await findAdminByEmail(tenantId, email);
  if (!admin || !admin.active) {
    return null;
  }

  const valid = await verifyPassword(password, admin.passwordHash);
  if (!valid) {
    return null;
  }

  return createAdminSession(admin.id, tenantId);
}

/**
 * Valida el token de sesión y, en cada request (no solo en el login), que
 * `admins.active` siga en true — es lo que garantiza la revocación
 * inmediata al desactivar un colaborador (ver ADR-025). También exige que
 * el `tenantId` de la URL coincida con el de la sesión, para que un token
 * de un tenant no pueda reutilizarse contra la URL de otro.
 */
export async function validateSession(
  token: string,
  tenantId: string,
): Promise<AdminRecord | null> {
  const session = await resolveAdminSession(token);
  if (!session || session.tenantId !== tenantId) {
    return null;
  }

  const admin = await getAdminById(tenantId, session.adminId);
  if (!admin || !admin.active) {
    return null;
  }

  return admin;
}

export async function logout(token: string): Promise<void> {
  await deleteAdminSession(token);
}
