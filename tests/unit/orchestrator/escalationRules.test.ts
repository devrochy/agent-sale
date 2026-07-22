import { describe, expect, it } from "vitest";
import {
  DEFAULT_ESCALATION_CONFIG,
  isMontoAlto,
  matchKeywordEscalation,
  resolveEscalationConfig,
} from "../../../src/orchestrator/escalationRules.js";

describe("resolveEscalationConfig", () => {
  it("devuelve los defaults si el tenant no configuró nada", () => {
    expect(resolveEscalationConfig(null)).toEqual(DEFAULT_ESCALATION_CONFIG);
  });

  it("usa el override del tenant campo por campo, sin combinar con los defaults", () => {
    const config = resolveEscalationConfig({
      maxIntentosFallidos: 5,
      keywords: [{ reason: "queja", terms: ["horrible"] }],
    });

    expect(config.maxIntentosFallidos).toBe(5);
    expect(config.keywords).toEqual([{ reason: "queja", terms: ["horrible"] }]);
    // montoAltoThreshold no vino en el override: usa el default.
    expect(config.montoAltoThreshold).toBe(DEFAULT_ESCALATION_CONFIG.montoAltoThreshold);
  });

  it("ignora un override con forma inválida y cae en los defaults de ese campo", () => {
    const config = resolveEscalationConfig({ keywords: "no es un array" });
    expect(config.keywords).toEqual(DEFAULT_ESCALATION_CONFIG.keywords);
  });
});

describe("matchKeywordEscalation", () => {
  const config = resolveEscalationConfig(null);

  it("detecta una palabra clave de queja sin importar mayúsculas/minúsculas", () => {
    const match = matchKeywordEscalation("Esto es una ESTAFA, quiero mi plata", config);
    expect(match).toMatchObject({ reason: "queja" });
  });

  it("detecta una solicitud explícita de hablar con una persona", () => {
    const match = matchKeywordEscalation("quiero hablar con una persona ya", config);
    expect(match).toMatchObject({ reason: "solicitud_cliente" });
  });

  it("devuelve null si el mensaje no contiene ningún término configurado", () => {
    expect(matchKeywordEscalation("tienen cascos talla M?", config)).toBeNull();
  });
});

describe("isMontoAlto", () => {
  const config = resolveEscalationConfig(null);

  it("es true si el monto supera el umbral configurado", () => {
    expect(isMontoAlto(config.montoAltoThreshold + 1, config)).toBe(true);
  });

  it("es false si el monto es igual o menor al umbral", () => {
    expect(isMontoAlto(config.montoAltoThreshold, config)).toBe(false);
    expect(isMontoAlto(config.montoAltoThreshold - 1, config)).toBe(false);
  });
});
