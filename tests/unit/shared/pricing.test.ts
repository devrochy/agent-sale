import { describe, expect, it } from "vitest";
import { calculateCost, MODEL_PRICING } from "../../../src/shared/pricing.js";

describe("calculateCost", () => {
  it("calcula el costo de un modelo conocido", () => {
    // claude-haiku-4-5: $1/$5 por MTok — 1M de entrada + 1M de salida = $6.
    const cost = calculateCost("claude-haiku-4-5", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(6.0, 6);
  });

  it("cero tokens devuelve costo cero, no null", () => {
    expect(calculateCost("claude-sonnet-5", 0, 0)).toBe(0);
  });

  it("un modelo desconocido devuelve null, no lanza ni asume un precio", () => {
    expect(calculateCost("modelo-inexistente", 1000, 1000)).toBeNull();
  });

  it("los 12 modelos del catálogo tienen una entrada de precio", () => {
    const catalogModelIds = [
      "claude-haiku-4-5",
      "claude-sonnet-5",
      "claude-opus-5",
      "deepseek-chat",
      "gpt-4o-mini",
      "gpt-4o",
      "gpt-4.1",
      "grok-4-fast-non-reasoning",
      "grok-4",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
    ];
    for (const modelId of catalogModelIds) {
      expect(MODEL_PRICING[modelId]).toBeDefined();
    }
  });
});
