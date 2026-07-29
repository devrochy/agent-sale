import { pool } from "./pool.js";

/**
 * Único punto que consulta `tenants` directamente, sin pasar por
 * `withTenant` — porque resolver el tenant_id es justamente el paso
 * anterior a poder abrir una sesión con `app.tenant_id` seteado (ver
 * migrations/0010_rls_policies.cjs, nota sobre por qué `tenants` no tiene
 * RLS). Ningún otro módulo debería consultar `tenants` con el pool crudo.
 */
export async function findTenantIdByWhatsappNumber(whatsappNumber: string): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM tenants WHERE whatsapp_number = $1",
    [whatsappNumber],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Listado de tenants para el panel admin (ver src/admin/adminPanel.ts) —
 * es una página interna, no una tool ni un dominio con RLS, así que lee
 * `tenants` directo igual que el resto de este módulo.
 */
export interface TenantSummary {
  id: string;
  name: string;
  display_name: string | null;
  whatsapp_number: string | null;
}

export async function listTenants(): Promise<TenantSummary[]> {
  const result = await pool.query<TenantSummary>(
    "SELECT id, name, display_name, whatsapp_number FROM tenants ORDER BY name",
  );
  return result.rows;
}

/**
 * Un tenant puntual para el `layout()` del panel admin (ver ADR-016): la
 * marca mostrada es `display_name ?? name` — `null` si el id no existe.
 * `whatsapp_number` se usa para mostrar el canal configurado en el riel de
 * navegación (dato real, no un estado de "conectado" en vivo — eso es
 * alcance de la Fase 11.3, Conexiones).
 */
export async function getTenant(tenantId: string): Promise<TenantSummary | null> {
  const result = await pool.query<TenantSummary>(
    "SELECT id, name, display_name, whatsapp_number FROM tenants WHERE id = $1",
    [tenantId],
  );
  return result.rows[0] ?? null;
}

/**
 * Overrides de escalamiento del tenant (ver
 * migrations/0014_tenants_escalation_config.cjs) — `null` si el tenant no
 * configuró nada, en cuyo caso src/orchestrator/escalationRules.ts aplica
 * los defaults.
 */
export async function getEscalationConfig(
  tenantId: string,
): Promise<Record<string, unknown> | null> {
  const result = await pool.query<{ escalation_config: Record<string, unknown> | null }>(
    "SELECT escalation_config FROM tenants WHERE id = $1",
    [tenantId],
  );
  return result.rows[0]?.escalation_config ?? null;
}
