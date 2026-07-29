import { describe, expect, it } from "vitest";
import {
  DEFAULT_BEHAVIOR_CONFIG,
  resolveBehaviorConfig,
} from "../../../src/orchestrator/behaviorConfig.js";

describe("resolveBehaviorConfig", () => {
  it("devuelve los defaults si el tenant no configuró nada", () => {
    expect(resolveBehaviorConfig(null)).toEqual(DEFAULT_BEHAVIOR_CONFIG);
  });

  it("los defaults son el comportamiento de antes de esta fase (calido, un_mensaje)", () => {
    expect(DEFAULT_BEHAVIOR_CONFIG).toEqual({ tono: "calido", estiloMensajes: "un_mensaje" });
  });

  it("usa el override del tenant campo por campo, sin combinar con los defaults", () => {
    const config = resolveBehaviorConfig({ tono: "formal" });
    expect(config.tono).toBe("formal");
    // estiloMensajes no vino en el override: usa el default.
    expect(config.estiloMensajes).toBe(DEFAULT_BEHAVIOR_CONFIG.estiloMensajes);
  });

  it("ignora un valor de tono inválido y cae en el default", () => {
    const config = resolveBehaviorConfig({ tono: "agresivo" });
    expect(config.tono).toBe(DEFAULT_BEHAVIOR_CONFIG.tono);
  });

  it("ignora un valor de estiloMensajes inválido y cae en el default", () => {
    const config = resolveBehaviorConfig({ estiloMensajes: "burbujas_infinitas" });
    expect(config.estiloMensajes).toBe(DEFAULT_BEHAVIOR_CONFIG.estiloMensajes);
  });

  it("acepta los 3 valores válidos de tono y los 3 de estiloMensajes", () => {
    for (const tono of ["calido", "formal", "divertido"] as const) {
      expect(resolveBehaviorConfig({ tono }).tono).toBe(tono);
    }
    for (const estiloMensajes of ["un_mensaje", "pocos_cortos", "varios_cortos"] as const) {
      expect(resolveBehaviorConfig({ estiloMensajes }).estiloMensajes).toBe(estiloMensajes);
    }
  });
});
