import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../../../src/orchestrator/systemPrompt.js";

describe("SYSTEM_PROMPT", () => {
  it("es un string estático sin invalidadores silenciosos de caché (ver prompt-caching.md)", () => {
    expect(typeof SYSTEM_PROMPT).toBe("string");
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(SYSTEM_PROMPT).not.toMatch(/\$\{/);
    expect(SYSTEM_PROMPT).not.toMatch(/new Date|Date\.now|Math\.random|uuid/i);
  });

  it("es idéntico entre importaciones (no se regenera dinámicamente)", async () => {
    const reimported = await import("../../../src/orchestrator/systemPrompt.js");
    expect(reimported.SYSTEM_PROMPT).toBe(SYSTEM_PROMPT);
  });

  it("instruye responder en el idioma del cliente (Fase 12.1, multi-idioma)", () => {
    expect(SYSTEM_PROMPT).toMatch(/idioma que use el cliente/);
  });

  it('instruye el formato exacto "Quedan N" para stock (Fase 12.1, requisito del guardrail de stock)', () => {
    expect(SYSTEM_PROMPT).toMatch(/"Quedan N"/);
  });
});
