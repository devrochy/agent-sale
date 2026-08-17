import {
  createAdminSession,
  deleteAdminSession,
  resolveAdminSession,
} from "./adminSessionDirectory.js";
import { findAdminByUsernameOrEmail, getAdminById, type AdminRecord } from "./adminsDirectory.js";
import { verifyPassword } from "./passwordHash.js";

/**
 * Login combinado (Fase 13 v2, ver ADR-032): `identifier` matchea contra
 * `username` O `email`, un solo campo de formulario. Credenciales
 * inválidas y cuenta desactivada devuelven lo mismo (null) — no se filtra
 * cuál de los dos casos fue, mismo criterio que verifyPassword.
 */
export async function login(identifier: string, password: string): Promise<string | null> {
  const admin = await findAdminByUsernameOrEmail(identifier);
  if (!admin || !admin.active) {
    return null;
  }

  const valid = await verifyPassword(password, admin.passwordHash);
  if (!valid) {
    return null;
  }

  return createAdminSession(admin.id);
}

/**
 * Valida el token de sesión y, en cada request (no solo en el login), que
 * `admins.active` siga en true — es lo que garantiza la revocación
 * inmediata al desactivar un colaborador (ver ADR-025).
 */
export async function validateSession(token: string): Promise<AdminRecord | null> {
  const session = await resolveAdminSession(token);
  if (!session) {
    return null;
  }

  const admin = await getAdminById(session.adminId);
  if (!admin || !admin.active) {
    return null;
  }

  return admin;
}

export async function logout(token: string): Promise<void> {
  await deleteAdminSession(token);
}
