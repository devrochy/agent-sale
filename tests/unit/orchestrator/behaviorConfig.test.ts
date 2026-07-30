import { describe, expect, it } from "vitest";
import {
  DEFAULT_BEHAVIOR_CONFIG,
  resolveBehaviorConfig,
} from "../../../src/orchestrator/behaviorConfig.js";

describe("resolveBehaviorConfig", () => {
  it("devuelve los defaults si el tenant no configuró nada", () => {
    expect(resolveBehaviorConfig(null)).toEqual(DEFAULT_BEHAVIOR_CONFIG);
  });

  it("los defaults son el comportamiento de antes de esta fase (calido, un_mensaje, inmediato)", () => {
    expect(DEFAULT_BEHAVIOR_CONFIG).toEqual({
      tono: "calido",
      estiloMensajes: "un_mensaje",
      velocidadRespuesta: "inmediato",
    });
  });

  it("usa el override del tenant campo por campo, sin combinar con los defaults", () => {
    const config = resolveBehaviorConfig({ tono: "formal" });
    expect(config.tono).toBe("formal");
    // estiloMensajes/velocidadRespuesta no vinieron en el override: usan el default.
    expect(config.estiloMensajes).toBe(DEFAULT_BEHAVIOR_CONFIG.estiloMensajes);
    expect(config.velocidadRespuesta).toBe(DEFAULT_BEHAVIOR_CONFIG.velocidadRespuesta);
  });

  it("ignora un valor de tono inválido y cae en el default", () => {
    const config = resolveBehaviorConfig({ tono: "agresivo" });
    expect(config.tono).toBe(DEFAULT_BEHAVIOR_CONFIG.tono);
  });

  it("ignora un valor de estiloMensajes inválido y cae en el default", () => {
    const config = resolveBehaviorConfig({ estiloMensajes: "burbujas_infinitas" });
    expect(config.estiloMensajes).toBe(DEFAULT_BEHAVIOR_CONFIG.estiloMensajes);
  });

  it("ignora un valor de velocidadRespuesta inválido y cae en el default", () => {
    const config = resolveBehaviorConfig({ velocidadRespuesta: "instantaneo" });
    expect(config.velocidadRespuesta).toBe(DEFAULT_BEHAVIOR_CONFIG.velocidadRespuesta);
  });

  it("acepta los 3 valores válidos de tono y los 3 de estiloMensajes", () => {
    for (const tono of ["calido", "formal", "divertido"] as const) {
      expect(resolveBehaviorConfig({ tono }).tono).toBe(tono);
    }
    for (const estiloMensajes of ["un_mensaje", "pocos_cortos", "varios_cortos"] as const) {
      expect(resolveBehaviorConfig({ estiloMensajes }).estiloMensajes).toBe(estiloMensajes);
    }
  });

  it("acepta los 4 valores válidos de velocidadRespuesta", () => {
    for (const velocidadRespuesta of ["inmediato", "rapido", "normal", "pausado"] as const) {
      expect(resolveBehaviorConfig({ velocidadRespuesta }).velocidadRespuesta).toBe(
        velocidadRespuesta,
      );
    }
  });
});
