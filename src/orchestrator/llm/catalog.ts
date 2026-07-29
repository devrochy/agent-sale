// Catálogo de proveedores/modelos configurables por tenant (Fase 11.4, ver
// docs/fase-11-panel-admin-dashboard/adrs/ADR-020-proveedor-modelo-configurable-byok.md).
// Puramente declarativo — la lógica de qué clase de LLMProvider instanciar
// para cada `family` vive en resolveLlmProviderForTenant (llm/index.ts).
//
// "deepseek"/"openai"/"xai" comparten la misma family "openai_compatible"
// (OpenAICompatibleProvider ya existente, ver ADR-010: los tres hablan el
// mismo formato de chat completions) — solo cambia `baseUrl`. Solo
// "gemini" necesita una implementación nueva porque su API tiene un shape
// distinto (generateContent, no chat completions).
export type ProviderFamily = "anthropic" | "openai_compatible" | "gemini";
export type ProviderKey = "anthropic" | "deepseek" | "openai" | "xai" | "gemini";

export interface ModelOption {
  id: string;
  label: string;
}

export interface ProviderCatalogEntry {
  label: string;
  family: ProviderFamily;
  /** Solo aplica a family "openai_compatible" — AnthropicProvider usa el SDK, GeminiProvider tiene su endpoint fijo. */
  baseUrl?: string;
  defaultModel: string;
  models: ModelOption[];
  /** Prefijo típico de la API key de este proveedor, solo para el placeholder del campo BYOK en el panel. */
  keyPlaceholder: string;
}

export const PROVIDER_CATALOG: Record<ProviderKey, ProviderCatalogEntry> = {
  anthropic: {
    label: "Claude (Anthropic)",
    family: "anthropic",
    defaultModel: "claude-sonnet-5",
    models: [
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 · rápido y barato" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5 · el mejor equilibrio" },
      { id: "claude-opus-5", label: "Claude Opus 5 · máxima inteligencia" },
    ],
    keyPlaceholder: "sk-ant-…",
  },
  deepseek: {
    label: "DeepSeek",
    family: "openai_compatible",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    models: [{ id: "deepseek-chat", label: "DeepSeek Chat · rápido y económico" }],
    keyPlaceholder: "sk-…",
  },
  openai: {
    label: "ChatGPT (OpenAI)",
    family: "openai_compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    models: [
      { id: "gpt-4o-mini", label: "GPT-4o mini · rápido y barato" },
      { id: "gpt-4o", label: "GPT-4o · equilibrado" },
      { id: "gpt-4.1", label: "GPT-4.1 · más capaz" },
    ],
    keyPlaceholder: "sk-…",
  },
  xai: {
    label: "Grok (xAI)",
    family: "openai_compatible",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4-fast-non-reasoning",
    models: [
      { id: "grok-4-fast-non-reasoning", label: "Grok 4 Fast · rápido y barato" },
      { id: "grok-4", label: "Grok 4 · más capaz" },
    ],
    keyPlaceholder: "xai-…",
  },
  gemini: {
    label: "Gemini (Google)",
    family: "gemini",
    defaultModel: "gemini-2.5-flash",
    models: [
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite · el más rápido y barato" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash · equilibrado" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro · máxima inteligencia" },
    ],
    keyPlaceholder: "AIza…",
  },
};

export function isProviderKey(value: string): value is ProviderKey {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CATALOG, value);
}
