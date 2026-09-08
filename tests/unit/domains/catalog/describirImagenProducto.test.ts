import { describe, expect, it } from "vitest";
import { parsearDescripcion } from "../../../../src/domains/catalog/describirImagenProducto.js";

describe("parsearDescripcion", () => {
  it("devuelve la descripción cuando Claude identificó un producto", () => {
    const resultado = parsearDescripcion('{"producto": "casco integral negro con visor ahumado"}');
    expect(resultado).toBe("casco integral negro con visor ahumado");
  });

  it('devuelve null cuando el modelo respondió producto: null (no identificó nada)', () => {
    expect(parsearDescripcion('{"producto": null}')).toBeNull();
  });

  it("recorta espacios alrededor de la descripción", () => {
    expect(parsearDescripcion('{"producto": "  guantes de cuero café  "}')).toBe("guantes de cuero café");
  });

  it("saca el JSON aunque venga envuelto en un bloque de código ```json", () => {
    const texto = '```json\n{"producto": "chaqueta de cuero negra"}\n```';
    expect(parsearDescripcion(texto)).toBe("chaqueta de cuero negra");
  });

  it("devuelve null si la respuesta no es JSON parseable (el modelo no respetó el formato)", () => {
    expect(parsearDescripcion("No veo ningún producto en la foto.")).toBeNull();
  });

  it("devuelve null si el texto viene vacío", () => {
    expect(parsearDescripcion("")).toBeNull();
    expect(parsearDescripcion("   ")).toBeNull();
  });

  it('devuelve null si "producto" no es un string (formato inesperado)', () => {
    expect(parsearDescripcion('{"producto": 123}')).toBeNull();
    expect(parsearDescripcion('{"producto": ""}')).toBeNull();
    expect(parsearDescripcion("{}")).toBeNull();
  });
});
