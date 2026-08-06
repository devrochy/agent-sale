import { describe, expect, it } from "vitest";
import {
  buildBrandVoiceBlock,
  EMPTY_BRAND_VOICE_CONFIG,
  resolveBrandVoiceConfig,
} from "../../../src/orchestrator/brandVoiceBlock.js";

describe("resolveBrandVoiceConfig", () => {
  it("devuelve todos los campos vacíos si el tenant no configuró nada", () => {
    expect(resolveBrandVoiceConfig(null)).toEqual(EMPTY_BRAND_VOICE_CONFIG);
  });

  it("usa el override del tenant campo por campo, sin combinar con los defaults", () => {
    const config = resolveBrandVoiceConfig({ mision: "Vender con confianza." });
    expect(config.mision).toBe("Vender con confianza.");
    expect(config.vision).toBe("");
    expect(config.valores).toBe("");
  });

  it("recorta espacios en blanco de los campos", () => {
    expect(resolveBrandVoiceConfig({ nombreAsistente: "  Sofía  " }).nombreAsistente).toBe("Sofía");
  });

  it("ignora un valor que no sea string y cae en vacío", () => {
    expect(resolveBrandVoiceConfig({ mision: 123 as unknown as string }).mision).toBe("");
  });
});

describe("buildBrandVoiceBlock", () => {
  it("devuelve null si no hay ningún campo configurado", () => {
    expect(buildBrandVoiceBlock(EMPTY_BRAND_VOICE_CONFIG)).toBeNull();
  });

  it("incluye solo los campos configurados", () => {
    const block = buildBrandVoiceBlock({
      ...EMPTY_BRAND_VOICE_CONFIG,
      mision: "Vender con confianza.",
    });
    expect(block).toContain("Vender con confianza.");
    expect(block).not.toContain("Visión de la empresa");
    expect(block).not.toContain("Valores de la empresa");
  });

  it("incluye todos los campos cuando todos están configurados", () => {
    const block = buildBrandVoiceBlock({
      nombreAsistente: "Sofía",
      mision: "Misión X",
      vision: "Visión Y",
      valores: "Respeto, calidad",
      nomenclatura: "Los pedidos se llaman 'órdenes'.",
    });
    expect(block).toContain("Sofía");
    expect(block).toContain("Misión X");
    expect(block).toContain("Visión Y");
    expect(block).toContain("Respeto, calidad");
    expect(block).toContain("órdenes");
  });
});
