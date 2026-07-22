import type { EscalationReason } from "../domains/escalation/escalarHumano.js";

export interface KeywordRule {
  reason: Extract<EscalationReason, "queja" | "solicitud_cliente">;
  terms: string[];
}

export interface EscalationConfig {
  keywords: KeywordRule[];
  maxIntentosFallidos: number;
  montoAltoThreshold: number;
}

/**
 * Defaults para ForMotos (ver docs/fase-7-escalamiento-humano/reglas-escalamiento.md):
 * el umbral de monto alto es la propuesta inicial de la Fase 0 (~3x el
 * ticket promedio, $300.000 COP), a validar con datos reales del piloto.
 * Un tenant sin `escalation_config` en la tabla `tenants` usa esto tal
 * cual (ver migrations/0014_tenants_escalation_config.cjs).
 */
export const DEFAULT_ESCALATION_CONFIG: EscalationConfig = {
  keywords: [
    { reason: "queja", terms: ["reclamo", "estafa", "pésimo", "terrible", "muy mal servicio"] },
    {
      reason: "solicitud_cliente",
      terms: [
        "hablar con una persona",
        "hablar con alguien",
        "pásame con un asesor",
        "quiero un asesor",
        "hablar con un humano",
      ],
    },
  ],
  maxIntentosFallidos: 3,
  montoAltoThreshold: 300000,
};

function isKeywordRule(value: unknown): value is KeywordRule {
  return (
    typeof value === "object" &&
    value !== null &&
    "reason" in value &&
    "terms" in value &&
    Array.isArray((value as { terms: unknown }).terms)
  );
}

/**
 * Mergea el override del tenant (jsonb, forma libre) sobre los defaults —
 * campo por campo, sin merge profundo: si el tenant definió `keywords`,
 * reemplaza la lista completa (no se combinan términos default + tenant).
 */
export function resolveEscalationConfig(
  override: Record<string, unknown> | null,
): EscalationConfig {
  if (!override) {
    return DEFAULT_ESCALATION_CONFIG;
  }

  const keywords = Array.isArray(override.keywords)
    ? override.keywords.filter(isKeywordRule)
    : DEFAULT_ESCALATION_CONFIG.keywords;

  return {
    keywords,
    maxIntentosFallidos:
      typeof override.maxIntentosFallidos === "number"
        ? override.maxIntentosFallidos
        : DEFAULT_ESCALATION_CONFIG.maxIntentosFallidos,
    montoAltoThreshold:
      typeof override.montoAltoThreshold === "number"
        ? override.montoAltoThreshold
        : DEFAULT_ESCALATION_CONFIG.montoAltoThreshold,
  };
}

export interface KeywordMatch {
  reason: Extract<EscalationReason, "queja" | "solicitud_cliente">;
  matchedTerm: string;
}

/**
 * Backstop determinístico sobre el mensaje del cliente (ver
 * reglas-escalamiento.md: "palabras clave... configurable por tenant").
 * No reemplaza el criterio del LLM para solicitud_cliente/queja —
 * Claude ya puede llamar escalar_a_humano por su cuenta ante estos casos
 * (ver systemPrompt.ts) — esto solo garantiza que un término
 * suficientemente explícito siempre escale, aunque el modelo no lo capte.
 */
export function matchKeywordEscalation(
  message: string,
  config: EscalationConfig,
): KeywordMatch | null {
  const normalized = message.toLowerCase();
  for (const rule of config.keywords) {
    const matchedTerm = rule.terms.find((term) => normalized.includes(term.toLowerCase()));
    if (matchedTerm) {
      return { reason: rule.reason, matchedTerm };
    }
  }
  return null;
}

/** Regla de monto alto (ver reglas-escalamiento.md). */
export function isMontoAlto(amount: number, config: EscalationConfig): boolean {
  return amount > config.montoAltoThreshold;
}
