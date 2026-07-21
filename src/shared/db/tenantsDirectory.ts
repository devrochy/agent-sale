import { pool } from "./pool.js";

/**
 * Único punto que consulta `tenants` directamente, sin pasar por
 * `withTenant` — porque resolver el tenant_id es justamente el paso
 * anterior a poder abrir una sesión con `app.tenant_id` seteado (ver
 * migrations/0010_rls_policies.cjs, nota sobre por qué `tenants` no tiene
 * RLS). Ningún otro módulo debería consultar `tenants` con el pool crudo.
 */
export async function findTenantIdByWhatsappNumber(
  whatsappNumber: string,
): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM tenants WHERE whatsapp_number = $1",
    [whatsappNumber],
  );
  return result.rows[0]?.id ?? null;
}
