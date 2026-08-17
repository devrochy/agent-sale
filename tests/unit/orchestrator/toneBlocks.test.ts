import { describe, expect, it } from "vitest";
import { isTono, TONE_BLOCKS } from "../../../src/orchestrator/toneBlocks.js";

describe("TONE_BLOCKS", () => {
  it.each(["calido", "formal", "divertido"] as const)(
    "%s es un string estático sin invalidadores silenciosos de caché (ver prompt-caching.md)",
    (tono) => {
      const block = TONE_BLOCKS[tono];
      expect(typeof block).toBe("string");
      expect(block.length).toBeGreaterThan(0);
      expect(block).not.toMatch(/\$\{/);
      expect(block).not.toMatch(/new Date|Date\.now|Math\.random|uuid/i);
    },
  );

  it("es idéntico entre importaciones (no se regenera dinámicamente)", async () => {
    const reimported = await import("../../../src/orchestrator/toneBlocks.js");
    expect(reimported.TONE_BLOCKS.calido).toBe(TONE_BLOCKS.calido);
  });

  it("las 3 variantes cubren los mismos 3 escenarios de ejemplo (paridad de contenido)", () => {
    for (const tono of ["calido", "formal", "divertido"] as const) {
      const block = TONE_BLOCKS[tono];
      expect(block).toMatch(/Tienen cascos integrales\?/);
      expect(block).toMatch(/Cuánto me queda con el descuento\?/);
      expect(block).toMatch(/Ese precio me parece caro/);
    }
  });
});

describe("isTono", () => {
  it("acepta los 3 valores válidos", () => {
    expect(isTono("calido")).toBe(true);
    expect(isTono("formal")).toBe(true);
    expect(isTono("divertido")).toBe(true);
  });

  it("rechaza valores inválidos", () => {
    expect(isTono("")).toBe(false);
    expect(isTono("agresivo")).toBe(false);
  });
});
