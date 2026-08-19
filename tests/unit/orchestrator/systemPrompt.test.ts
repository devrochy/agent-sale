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

  it("prohíbe decir cuántas unidades hay", () => {
    // La regla anterior pedía el formato exacto "Quedan N" con el número
    // real. Se retiró: el número no le cambia la decisión al cliente, y
    // mientras el prompt lo autorizaba el agente lo escribía en cada
    // respuesta. Ahora ese formato no debe aparecer ni como ejemplo.
    expect(SYSTEM_PROMPT).toMatch(/Nunca digas cuántas unidades hay/);
    expect(SYSTEM_PROMPT).not.toMatch(/formato exacto "Quedan N"/);
  });

  it("manda ofrecer asesor y alternativas cuando un producto no está disponible", () => {
    expect(SYSTEM_PROMPT).toMatch(/"disponible": false/);
    expect(SYSTEM_PROMPT).toMatch(/escalar_a_humano/);
    expect(SYSTEM_PROMPT).toMatch(/recomendar_producto/);
  });

  it("ata la foto a la consulta por sku y no a que haya un solo resultado", () => {
    // Una búsqueda por texto con un único resultado mandaba una foto que
    // nadie había pedido.
    expect(SYSTEM_PROMPT).toMatch(/solo cuando consultaste por "sku"/);
    expect(SYSTEM_PROMPT).toMatch(/nunca manda foto, aunque devuelva un solo resultado/);
  });

  it("fija una forma única para las listas de productos", () => {
    expect(SYSTEM_PROMPT).toMatch(/UNA línea por producto/);
    expect(SYSTEM_PROMPT).toMatch(/Máximo 5 productos por lista/);
  });
});
