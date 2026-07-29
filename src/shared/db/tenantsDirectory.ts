import { decryptSecret, encryptSecret } from "../crypto/secretBox.js";
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
  // Kill-switch de la Fase 11.4 (ver configuracion-comportamiento.md) —
  // deliberadamente SÍ va en TenantSummary (a diferencia de la config de
  // LLM, ver getLlmConfig más abajo): es un booleano liviano que varias
  // páginas del panel necesitan mostrar, no un secreto.
  bot_paused: boolean;
}

const TENANT_SUMMARY_COLUMNS = "id, name, display_name, whatsapp_number, bot_paused";

export async function listTenants(): Promise<TenantSummary[]> {
  const result = await pool.query<TenantSummary>(
    `SELECT ${TENANT_SUMMARY_COLUMNS} FROM tenants ORDER BY name`,
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
    `SELECT ${TENANT_SUMMARY_COLUMNS} FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return result.rows[0] ?? null;
}

/**
 * Kill-switch (Fase 11.4): pausa/reactiva el bot de un tenant desde el
 * panel — ver configuracion-comportamiento.md, chequeado en
 * src/orchestrator/consumer.ts antes de invocar el orquestador.
 */
export async function setBotPaused(tenantId: string, paused: boolean): Promise<void> {
  await pool.query("UPDATE tenants SET bot_paused = $1 WHERE id = $2", [paused, tenantId]);
}

/**
 * Config de proveedor/modelo de LLM por tenant (Fase 11.4, ver
 * ADR-020-proveedor-modelo-configurable-byok.md) — deliberadamente
 * separada de TenantSummary/getTenant: es la única función que lee
 * `llm_api_key_encrypted` y la desencripta, para que la key cifrada no
 * viaje "de paso" en cada carga de página del panel que solo necesita
 * branding/nav (getTenant).
 */
export interface TenantLlmConfig {
  provider: string | null;
  model: string | null;
  /** Ya desencriptada — `null` si el tenant no trajo su propia key (usar la del sistema). */
  apiKey: string | null;
}

export async function getLlmConfig(tenantId: string): Promise<TenantLlmConfig> {
  const result = await pool.query<{
    llm_provider: string | null;
    llm_model: string | null;
    llm_api_key_encrypted: string | null;
  }>("SELECT llm_provider, llm_model, llm_api_key_encrypted FROM tenants WHERE id = $1", [
    tenantId,
  ]);
  const row = result.rows[0];
  return {
    provider: row?.llm_provider ?? null,
    model: row?.llm_model ?? null,
    apiKey: row?.llm_api_key_encrypted ? decryptSecret(row.llm_api_key_encrypted) : null,
  };
}

/**
 * Guarda la elección de proveedor/modelo/API key del tenant — llamar solo
 * después de validar la combinación con una llamada de prueba real (ver
 * "Probar y guardar" en adminPanel.ts), nunca antes. `apiKey` en texto
 * plano se cifra acá adentro; `null`/`undefined` limpia el campo (volver a
 * usar la key del sistema).
 */
export async function saveLlmConfig(
  tenantId: string,
  config: { provider: string; model: string; apiKey?: string | null },
): Promise<void> {
  await pool.query(
    "UPDATE tenants SET llm_provider = $1, llm_model = $2, llm_api_key_encrypted = $3 WHERE id = $4",
    [config.provider, config.model, config.apiKey ? encryptSecret(config.apiKey) : null, tenantId],
  );
}

/**
 * Vuelve al "Automático" del panel (ver adminPanel.ts) — limpia el override
 * del tenant para que resolveLlmProviderForTenant vuelva a usar el default
 * de plataforma (env.LLM_PROVIDER/LLM_MODEL), el mismo comportamiento de
 * antes de la Fase 11.4.
 */
export async function clearLlmConfig(tenantId: string): Promise<void> {
  await pool.query(
    "UPDATE tenants SET llm_provider = NULL, llm_model = NULL, llm_api_key_encrypted = NULL WHERE id = $1",
    [tenantId],
  );
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

/**
 * Overrides de comportamiento del tenant — tono de voz y estilo de
 * mensajes (Fase 11.4 extendida, ver
 * docs/fase-11-panel-admin-dashboard/adrs/ADR-021-tono-personalizable-cache-jerarquico.md).
 * Mismo patrón que `getEscalationConfig`: `null` si el tenant no configuró
 * nada, en cuyo caso `src/orchestrator/behaviorConfig.ts` aplica los
 * defaults (comportamiento idéntico al de antes de esta fase).
 */
export async function getBehaviorConfig(tenantId: string): Promise<Record<string, unknown> | null> {
  const result = await pool.query<{ behavior_config: Record<string, unknown> | null }>(
    "SELECT behavior_config FROM tenants WHERE id = $1",
    [tenantId],
  );
  return result.rows[0]?.behavior_config ?? null;
}

/** Guarda el override de comportamiento del tenant — reemplaza el objeto completo, sin merge (el merge campo-a-campo pasa en resolveBehaviorConfig, no acá). */
export async function saveBehaviorConfig(
  tenantId: string,
  config: Record<string, unknown>,
): Promise<void> {
  await pool.query("UPDATE tenants SET behavior_config = $1 WHERE id = $2", [
    JSON.stringify(config),
    tenantId,
  ]);
}
