import { decryptSecret, encryptSecret } from "../crypto/secretBox.js";
import type { LlmRoutingMode } from "../../orchestrator/llm/catalog.js";
import { pool } from "./pool.js";

/**
 * Único punto que consulta `settings` directamente, con el pool crudo —
 * antes (ver ADR-004, superada) esto era el paso de resolver el
 * `tenant_id` previo a abrir una sesión con RLS; ADR-032 retiró
 * multi-tenancy, `settings` es ahora una tabla singleton (una sola fila
 * con la configuración del negocio) sin RLS que resolver.
 */
export interface SettingsSummary {
  id: string;
  name: string;
  display_name: string | null;
  whatsapp_number: string | null;
  // Kill-switch de la Fase 11.4 (ver configuracion-comportamiento.md) —
  // deliberadamente SÍ va acá (a diferencia de la config de LLM, ver
  // getLlmConfig más abajo): es un booleano liviano que varias páginas
  // del panel necesitan mostrar, no un secreto.
  bot_paused: boolean;
}

const SETTINGS_SUMMARY_COLUMNS = "id, name, display_name, whatsapp_number, bot_paused";

/**
 * `null` si todavía no se sembró la fila de `settings` (ambiente nuevo,
 * sin seed todavía) — mismo criterio que antes tenía `getTenant` para un
 * id inexistente, no es un error.
 */
export async function getSettings(): Promise<SettingsSummary | null> {
  const result = await pool.query<SettingsSummary>(
    `SELECT ${SETTINGS_SUMMARY_COLUMNS} FROM settings LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

/**
 * Kill-switch (Fase 11.4): pausa/reactiva el bot desde el panel — ver
 * configuracion-comportamiento.md, chequeado en
 * src/orchestrator/consumer.ts antes de invocar el orquestador.
 */
export async function setBotPaused(paused: boolean): Promise<void> {
  await pool.query("UPDATE settings SET bot_paused = $1", [paused]);
}

/**
 * Config de proveedor/modelo de LLM (Fase 11.4, ver
 * ADR-020-proveedor-modelo-configurable-byok.md) — deliberadamente
 * separada de SettingsSummary/getSettings: es la única función que lee
 * `llm_api_key_encrypted` y la desencripta, para que la key cifrada no
 * viaje "de paso" en cada carga de página del panel que solo necesita
 * branding/nav (getSettings).
 */
export interface LlmConfig {
  provider: string | null;
  model: string | null;
  /** Ya desencriptada — `null` si no se trajo una key propia (usar la del sistema). */
  apiKey: string | null;
  /** "Cerebro del bot" (ADR-023) — 'manual' = usa `model` tal cual; 'auto_dificultad' = lo ignora y elige por turno. */
  routingMode: LlmRoutingMode;
}

export async function getLlmConfig(): Promise<LlmConfig> {
  const result = await pool.query<{
    llm_provider: string | null;
    llm_model: string | null;
    llm_api_key_encrypted: string | null;
    llm_routing_mode: string;
  }>("SELECT llm_provider, llm_model, llm_api_key_encrypted, llm_routing_mode FROM settings");
  const row = result.rows[0];
  return {
    provider: row?.llm_provider ?? null,
    model: row?.llm_model ?? null,
    apiKey: row?.llm_api_key_encrypted ? decryptSecret(row.llm_api_key_encrypted) : null,
    routingMode: row?.llm_routing_mode === "auto_dificultad" ? "auto_dificultad" : "manual",
  };
}

/**
 * Guarda la elección de proveedor/modelo/API key/modo de ruteo — llamar
 * solo después de validar la combinación con una llamada de prueba real
 * (ver "Probar y guardar" en adminPanel.ts), nunca antes. `apiKey` en
 * texto plano se cifra acá adentro; `null`/`undefined` limpia el campo
 * (volver a usar la key del sistema). Con `routingMode: "auto_dificultad"`,
 * `model` igual se guarda (el valor que traía el form) pero el resolver
 * lo ignora en tiempo de turno — ver ADR-023.
 */
export async function saveLlmConfig(config: {
  provider: string;
  model: string;
  apiKey?: string | null;
  routingMode: LlmRoutingMode;
}): Promise<void> {
  await pool.query(
    "UPDATE settings SET llm_provider = $1, llm_model = $2, llm_api_key_encrypted = $3, llm_routing_mode = $4",
    [config.provider, config.model, config.apiKey ? encryptSecret(config.apiKey) : null, config.routingMode],
  );
}

/**
 * Vuelve al "Automático" del panel (ver adminPanel.ts) — limpia el override
 * para que resolveLlmProviderForTenant vuelva a usar el default de
 * plataforma (env.LLM_PROVIDER/LLM_MODEL), el mismo comportamiento de
 * antes de la Fase 11.4. También resetea el modo de ruteo a 'manual' —
 * "auto_dificultad" no tiene sentido sin un proveedor explícito elegido.
 */
export async function clearLlmConfig(): Promise<void> {
  await pool.query(
    "UPDATE settings SET llm_provider = NULL, llm_model = NULL, llm_api_key_encrypted = NULL, llm_routing_mode = 'manual'",
  );
}

/**
 * Config BYOK de Wompi (Fase 12.4, ver
 * ADR-024-cobros-wompi-confirmacion-automatica.md) — mismo criterio que
 * getLlmConfig: única función que lee y desencripta las llaves de Wompi,
 * para que no viajen "de paso" en cargas de página que no las necesitan.
 * `privateKey` se usa para crear links de pago (wompiClient.ts);
 * `eventsSecret` solo para verificar la firma de los webhooks entrantes
 * (wompiSignature.ts) — nunca se usa para llamar a la API de Wompi.
 */
export interface WompiConfig {
  privateKey: string | null;
  eventsSecret: string | null;
}

export async function getWompiConfig(): Promise<WompiConfig> {
  const result = await pool.query<{
    wompi_private_key_encrypted: string | null;
    wompi_events_secret_encrypted: string | null;
  }>("SELECT wompi_private_key_encrypted, wompi_events_secret_encrypted FROM settings");
  const row = result.rows[0];
  return {
    privateKey: row?.wompi_private_key_encrypted ? decryptSecret(row.wompi_private_key_encrypted) : null,
    eventsSecret: row?.wompi_events_secret_encrypted
      ? decryptSecret(row.wompi_events_secret_encrypted)
      : null,
  };
}

/**
 * Guarda la llave privada y el secreto de eventos de Wompi — llamar solo
 * después de validar la llave privada con una llamada de prueba real (ver
 * "Probar y guardar" en adminPanel.ts), nunca antes.
 */
export async function saveWompiConfig(config: {
  privateKey: string;
  eventsSecret: string;
}): Promise<void> {
  await pool.query("UPDATE settings SET wompi_private_key_encrypted = $1, wompi_events_secret_encrypted = $2", [
    encryptSecret(config.privateKey),
    encryptSecret(config.eventsSecret),
  ]);
}

/**
 * Overrides de escalamiento (ver
 * migrations/0014_tenants_escalation_config.cjs, columna conservada tal
 * cual en el rename a `settings`) — `null` si no se configuró nada, en
 * cuyo caso src/orchestrator/escalationRules.ts aplica los defaults.
 */
export async function getEscalationConfig(): Promise<Record<string, unknown> | null> {
  const result = await pool.query<{ escalation_config: Record<string, unknown> | null }>(
    "SELECT escalation_config FROM settings",
  );
  return result.rows[0]?.escalation_config ?? null;
}

/**
 * Overrides de comportamiento — tono de voz y estilo de mensajes (Fase
 * 11.4 extendida, ver
 * docs/fase-11-panel-admin-dashboard/adrs/ADR-021-tono-personalizable-cache-jerarquico.md).
 * Mismo patrón que `getEscalationConfig`: `null` si no se configuró nada,
 * en cuyo caso `src/orchestrator/behaviorConfig.ts` aplica los defaults.
 */
export async function getBehaviorConfig(): Promise<Record<string, unknown> | null> {
  const result = await pool.query<{ behavior_config: Record<string, unknown> | null }>(
    "SELECT behavior_config FROM settings",
  );
  return result.rows[0]?.behavior_config ?? null;
}

/** Guarda el override de comportamiento — reemplaza el objeto completo, sin merge (el merge campo-a-campo pasa en resolveBehaviorConfig, no acá). */
export async function saveBehaviorConfig(config: Record<string, unknown>): Promise<void> {
  await pool.query("UPDATE settings SET behavior_config = $1", [JSON.stringify(config)]);
}

/**
 * Número de WhatsApp que recibe el Reporte diario (Fase 12.2, ver
 * migrations/0024_tenants_report_recipient.cjs) — `null` si no se
 * configuró, en cuyo caso `src/jobs/dailyReport.ts` no manda reporte (no
 * es un error). Deliberadamente separado de `human_agents` (esa tabla es
 * para notificaciones de escalamiento, un rol distinto) y de `admins`
 * (permisos por colaborador, Fase 13 — este campo queda como fallback,
 * ver ADR-025).
 */
export async function getReportRecipient(): Promise<string | null> {
  const result = await pool.query<{ report_recipient_phone: string | null }>(
    "SELECT report_recipient_phone FROM settings",
  );
  return result.rows[0]?.report_recipient_phone ?? null;
}

/** `phone: null` limpia el campo (deja de recibir Reporte diario). */
export async function saveReportRecipient(phone: string | null): Promise<void> {
  await pool.query("UPDATE settings SET report_recipient_phone = $1", [phone]);
}

/**
 * Cada cuántos días se manda el Reporte del asistente (Fase 13 v2, ver
 * migrations/0038_settings_reporte_frecuencia.cjs) — 1 = diario (default,
 * preserva el comportamiento previo a este cambio), 7 = semanal, 30 =
 * mensual, o cualquier otro número para "personalizado". `sendDailyReports`
 * (dailyReport.ts) lo compara contra `getReportLastSentAt()` para decidir
 * si ya toca mandar el próximo.
 */
export async function getReportFrequencyDays(): Promise<number> {
  const result = await pool.query<{ report_frequency_days: number }>(
    "SELECT report_frequency_days FROM settings",
  );
  return result.rows[0]?.report_frequency_days ?? 1;
}

export async function saveReportFrequencyDays(days: number): Promise<void> {
  await pool.query("UPDATE settings SET report_frequency_days = $1", [days]);
}

/** `null` = todavía no se mandó nunca — `sendDailyReports` lo trata como "toca mandar ya". */
export async function getReportLastSentAt(): Promise<Date | null> {
  const result = await pool.query<{ report_last_sent_at: Date | null }>(
    "SELECT report_last_sent_at FROM settings",
  );
  return result.rows[0]?.report_last_sent_at ?? null;
}

/** Se llama solo después de un envío exitoso (al menos a un destinatario) — ver sendDailyReports. */
export async function markReportSent(): Promise<void> {
  await pool.query("UPDATE settings SET report_last_sent_at = now()");
}

/**
 * Link de reseña (Fase 12.2, ver migrations/0027_tenants_review_link.cjs)
 * — `null` si no se configuró, en cuyo caso
 * `src/orchestrator/satisfactionSurvey.ts` manda el agradecimiento de la
 * encuesta sin pedir reseña, nunca un link inventado.
 */
export async function getReviewLink(): Promise<string | null> {
  const result = await pool.query<{ review_link: string | null }>("SELECT review_link FROM settings");
  return result.rows[0]?.review_link ?? null;
}

/** `link: null` limpia el campo (deja de pedir reseñas). */
export async function saveReviewLink(link: string | null): Promise<void> {
  await pool.query("UPDATE settings SET review_link = $1", [link]);
}
