import { describe, expect, it } from "vitest";
import { splitForBubbles } from "../../../src/gateway/messageSplitter.js";

describe("splitForBubbles", () => {
  it("texto vacío devuelve un array vacío en cualquier estilo", () => {
    expect(splitForBubbles("", "un_mensaje")).toEqual([]);
    expect(splitForBubbles("   ", "pocos_cortos")).toEqual([]);
    expect(splitForBubbles("\n\n", "varios_cortos")).toEqual([]);
  });

  describe("un_mensaje", () => {
    it("siempre devuelve un único chunk con el texto completo, sin importar los saltos de línea", () => {
      const text = "Primer párrafo.\n\nSegundo párrafo.\n\nTercer párrafo.";
      expect(splitForBubbles(text, "un_mensaje")).toEqual([text]);
    });

    it("recorta espacios al principio/final", () => {
      expect(splitForBubbles("  hola  ", "un_mensaje")).toEqual(["hola"]);
    });
  });

  describe("pocos_cortos", () => {
    it("parte por salto de línea en blanco", () => {
      const text = "Primer párrafo.\n\nSegundo párrafo.";
      expect(splitForBubbles(text, "pocos_cortos")).toEqual([
        "Primer párrafo.",
        "Segundo párrafo.",
      ]);
    });

    it("sin saltos de línea en blanco, devuelve un único chunk", () => {
      expect(splitForBubbles("Todo en una línea.", "pocos_cortos")).toEqual(["Todo en una línea."]);
    });

    it("fusiona el excedente por encima del cap de 3 en el último chunk", () => {
      const text = "Uno.\n\nDos.\n\nTres.\n\nCuatro.\n\nCinco.";
      const result = splitForBubbles(text, "pocos_cortos");
      expect(result).toHaveLength(3);
      expect(result[0]).toBe("Uno.");
      expect(result[1]).toBe("Dos.");
      expect(result[2]).toBe("Tres.\n\nCuatro.\n\nCinco.");
    });
  });

  describe("varios_cortos", () => {
    it("parte por oración dentro de cada párrafo", () => {
      const text = "Hola! Tenemos varios modelos. ¿Cuál te interesa?";
      expect(splitForBubbles(text, "varios_cortos")).toEqual([
        "Hola!",
        "Tenemos varios modelos.",
        "¿Cuál te interesa?",
      ]);
    });

    it("combina párrafos y oraciones", () => {
      const text = "Sí, tenemos. Es un buen modelo.\n\n¿Te interesa?";
      expect(splitForBubbles(text, "varios_cortos")).toEqual([
        "Sí, tenemos.",
        "Es un buen modelo.",
        "¿Te interesa?",
      ]);
    });

    it("fusiona el excedente por encima del cap de 6", () => {
      const text = Array.from({ length: 8 }, (_, i) => `Oración ${i + 1}.`).join(" ");
      const result = splitForBubbles(text, "varios_cortos");
      expect(result).toHaveLength(6);
      expect(result[5]).toBe("Oración 6.\n\nOración 7.\n\nOración 8.");
    });
  });
});
