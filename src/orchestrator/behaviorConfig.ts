import { isTono, type Tono } from "./toneBlocks.js";

export type EstiloMensajes = "un_mensaje" | "pocos_cortos" | "varios_cortos";

export function isEstiloMensajes(value: unknown): value is EstiloMensajes {
  return value === "un_mensaje" || value === "pocos_cortos" || value === "varios_cortos";
}

export interface BehaviorConfig {
  tono: Tono;
  estiloMensajes: EstiloMensajes;
}

/**
 * Defaults = comportamiento de antes de esta fase, byte a byte: "calido"
 * es el texto que ya vivía en systemPrompt.ts (ver toneBlocks.ts) y
 * "un_mensaje" es como se manda la respuesta hoy (un solo mensaje de
 * WhatsApp por turno, ver messageSplitter.ts). Un tenant sin
 * `behavior_config` en `tenants` usa esto tal cual.
 */
export const DEFAULT_BEHAVIOR_CONFIG: BehaviorConfig = {
  tono: "calido",
  estiloMensajes: "un_mensaje",
};

/**
 * Mergea el override del tenant (jsonb, forma libre) sobre los defaults —
 * campo por campo, mismo criterio que resolveEscalationConfig en
 * escalationRules.ts: un campo inválido o ausente cae al default, no
 * invalida el resto del override.
 */
export function resolveBehaviorConfig(override: Record<string, unknown> | null): BehaviorConfig {
  if (!override) {
    return DEFAULT_BEHAVIOR_CONFIG;
  }

  return {
    tono:
      typeof override.tono === "string" && isTono(override.tono)
        ? override.tono
        : DEFAULT_BEHAVIOR_CONFIG.tono,
    estiloMensajes:
      typeof override.estiloMensajes === "string" && isEstiloMensajes(override.estiloMensajes)
        ? override.estiloMensajes
        : DEFAULT_BEHAVIOR_CONFIG.estiloMensajes,
  };
}
