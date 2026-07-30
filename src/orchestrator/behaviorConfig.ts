import { isTono, type Tono } from "./toneBlocks.js";

export type EstiloMensajes = "un_mensaje" | "pocos_cortos" | "varios_cortos";

export function isEstiloMensajes(value: unknown): value is EstiloMensajes {
  return value === "un_mensaje" || value === "pocos_cortos" || value === "varios_cortos";
}

/**
 * "inmediato" NO es un 4to nivel de espera, es la ausencia de debounce —
 * comportamiento de antes de esta fase (Fase 11.4 extendida, ver
 * ADR-022). Deliberadamente no se reutiliza "rapido" como default: hasta
 * "rapido" (5s) ya es más lento que procesar apenas llega el mensaje.
 */
export type VelocidadRespuesta = "inmediato" | "rapido" | "normal" | "pausado";

export function isVelocidadRespuesta(value: unknown): value is VelocidadRespuesta {
  return value === "inmediato" || value === "rapido" || value === "normal" || value === "pausado";
}

/** Ventana de debounce (ver debounceScheduler.ts) — "inmediato" no tiene entrada, nunca pasa por la cola de espera. */
export const DEBOUNCE_DELAY_MS: Record<Exclude<VelocidadRespuesta, "inmediato">, number> = {
  rapido: 5000,
  normal: 15000,
  pausado: 30000,
};

export interface BehaviorConfig {
  tono: Tono;
  estiloMensajes: EstiloMensajes;
  velocidadRespuesta: VelocidadRespuesta;
}

/**
 * Defaults = comportamiento de antes de esta fase, byte a byte: "calido"
 * es el texto que ya vivía en systemPrompt.ts (ver toneBlocks.ts),
 * "un_mensaje" es como se manda la respuesta hoy (ver messageSplitter.ts)
 * y "inmediato" es procesar apenas llega el mensaje, sin debounce (ver
 * debounceScheduler.ts). Un tenant sin `behavior_config` en `tenants` usa
 * esto tal cual.
 */
export const DEFAULT_BEHAVIOR_CONFIG: BehaviorConfig = {
  tono: "calido",
  estiloMensajes: "un_mensaje",
  velocidadRespuesta: "inmediato",
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
    velocidadRespuesta:
      typeof override.velocidadRespuesta === "string" &&
      isVelocidadRespuesta(override.velocidadRespuesta)
        ? override.velocidadRespuesta
        : DEFAULT_BEHAVIOR_CONFIG.velocidadRespuesta,
  };
}
