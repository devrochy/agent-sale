/**
 * Precios por modelo (Fase 11.5, ver docs/fase-11-panel-admin-dashboard/
 * analitica-costos.md) — USD por millón de tokens. Mapa por `model` solo
 * (no `provider:model`): los IDs de modelo de los 4 proveedores del
 * catálogo (ver src/orchestrator/llm/catalog.ts) no colisionan entre sí,
 * así que no hace falta el caso especial de `providerKey === "env-default"`
 * sin perder precisión.
 *
 * Precios de Anthropic confirmados con la skill `claude-api` (cacheados
 * 2026-06-24). Los de DeepSeek/OpenAI/xAI/Gemini NO están verificados en
 * vivo — valor conocido más reciente, con `// TODO: verificar precio
 * vigente` explícito en vez de asumir precisión que no se tiene.
 */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic — confirmado con la skill claude-api.
  "claude-haiku-4-5": { inputPer1M: 1.0, outputPer1M: 5.0 },
  // Precio introductorio vigente hasta 2026-08-31 — después vuelve a $3.00/$15.00 (ver ADR-008).
  "claude-sonnet-5": { inputPer1M: 2.0, outputPer1M: 10.0 },
  "claude-opus-5": { inputPer1M: 5.0, outputPer1M: 25.0 },

  // DeepSeek — TODO: verificar precio vigente (no confirmado en vivo).
  "deepseek-chat": { inputPer1M: 0.27, outputPer1M: 1.1 },

  // OpenAI — TODO: verificar precio vigente (no confirmado en vivo).
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },

  // xAI — TODO: verificar precio vigente (no confirmado en vivo).
  "grok-4-fast-non-reasoning": { inputPer1M: 0.2, outputPer1M: 0.5 },
  "grok-4": { inputPer1M: 3.0, outputPer1M: 15.0 },

  // Gemini — TODO: verificar precio vigente (no confirmado en vivo).
  "gemini-2.5-flash-lite": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10.0 },
};

/** `null` si el modelo no está en el mapa — no bloquea el insert de llm_usage, solo deja cost_usd sin calcular. */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    return null;
  }
  return (
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M
  );
}
