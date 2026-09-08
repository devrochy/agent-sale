import { describe, expect, it } from "vitest";
import { parsearDescripcion } from "../../../../src/domains/catalog/describirImagenProducto.js";

describe("parsearDescripcion", () => {
  it("devuelve la descripción cuando Claude identificó un producto", () => {
    const resultado = parsearDescripcion([{ type: "text", text: "casco integral negro con visor ahumado" }]);
    expect(resultado).toBe("casco integral negro con visor ahumado");
  });

  it('devuelve null cuando el modelo respondió "null" (no identificó nada)', () => {
    expect(parsearDescripcion([{ type: "text", text: "null" }])).toBeNull();
    expect(parsearDescripcion([{ type: "text", text: "  NULL  " }])).toBeNull();
  });

  it("recorta espacios alrededor de la descripción", () => {
    expect(parsearDescripcion([{ type: "text", text: "  guantes de cuero café  \n" }])).toBe("guantes de cuero café");
  });

  it("devuelve null si no hay ningún bloque de texto en la respuesta", () => {
    expect(parsearDescripcion([{ type: "image" }])).toBeNull();
    expect(parsearDescripcion([])).toBeNull();
  });

  it("devuelve null si el bloque de texto viene vacío", () => {
    expect(parsearDescripcion([{ type: "text", text: "" }])).toBeNull();
    expect(parsearDescripcion([{ type: "text", text: "   " }])).toBeNull();
  });
});
