import type { FastifyRequest } from "fastify";
import type { AdminRecord } from "./adminsDirectory.js";
import { validateSession } from "./session.js";

/**
 * Cookie de sesión, no firmada (ver ADR-025): el token en sí ya es el
 * secreto (24 bytes aleatorios validados contra `admin_sessions` en
 * Postgres) — firmar la cookie no agrega seguridad real acá, a
 * diferencia de un JWT que sí necesita firma porque sus claims son
 * legibles/editables del lado del cliente.
 */
export const SESSION_COOKIE_NAME = "agent_sale_admin_session";

/**
 * Único punto que lee la cookie de sesión y la valida contra el tenant de
 * la URL — usado tanto por el hook de auth de server.ts como por
 * cualquier handler que necesite saber quién es el admin actual (ver
 * Fase 13, sección "Colaboradores").
 */
export async function currentAdmin(
  request: FastifyRequest,
  tenantId: string,
): Promise<AdminRecord | null> {
  const token = request.cookies?.[SESSION_COOKIE_NAME];
  if (!token) {
    return null;
  }
  return validateSession(token, tenantId);
}
