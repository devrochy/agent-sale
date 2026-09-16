import { PROVIDER_CATALOG } from "../orchestrator/llm/catalog.js";

/**
 * Catálogo de proveedores de OCR/visión (comprobantes de pago, fotos de
 * producto — ver `payments/ocrComprobante.ts` y
 * `domains/catalog/describirImagenProducto.ts`), configurable por panel
 * igual que el catálogo del LLM conversacional (`orchestrator/llm/catalog.ts`,
 * ADR-020) pero deliberadamente en su propio archivo: mezclar los dos
 * catálogos confundiría dos capacidades distintas del mismo proveedor (ej.
 * DeepSeek habla `deepseek-chat` para chat y `deepseek-flash` para visión —
 * son modelos distintos con el mismo `family`).
 */
export type VisionProviderKey = "anthropic" | "deepseek" | "gemini";

export interface VisionModelOption {
  id: string;
  label: string;
}

export interface VisionCatalogEntry {
  label: string;
  family: "anthropic" | "openai_compatible" | "gemini";
  /** Solo aplica a family "openai_compatible" — Anthropic usa el SDK, Gemini tiene su endpoint fijo. */
  baseUrl?: string;
  defaultModel: string;
  models: VisionModelOption[];
  /** Prefijo típico de la API key de este proveedor, solo para el placeholder del campo BYOK en el panel. */
  keyPlaceholder: string;
}

export const VISION_PROVIDER_CATALOG: Record<VisionProviderKey, VisionCatalogEntry> = {
  anthropic: {
    label: "Claude (Anthropic)",
    family: "anthropic",
    defaultModel: "claude-sonnet-5",
    models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5 · el mejor equilibrio" }],
    keyPlaceholder: "sk-ant-…",
  },
  gemini: {
    label: "Gemini (Google)",
    family: "gemini",
    defaultModel: "gemini-2.5-flash-lite",
    models: [
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite · el más rápido y barato" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash · equilibrado" },
    ],
    keyPlaceholder: "AIza…",
  },
  deepseek: {
    label: "DeepSeek",
    family: "openai_compatible",
    // Misma URL base que el catálogo de LLM (orchestrator/llm/catalog.ts) —
    // se importa de ahí en vez de repetir el literal, única fuente de verdad.
    baseUrl: PROVIDER_CATALOG.deepseek.baseUrl,
    defaultModel: "deepseek-flash",
    models: [{ id: "deepseek-flash", label: "DeepSeek Flash · con visión, económico" }],
    keyPlaceholder: "sk-…",
  },
};

export function isVisionProviderKey(value: string): value is VisionProviderKey {
  return Object.prototype.hasOwnProperty.call(VISION_PROVIDER_CATALOG, value);
}
