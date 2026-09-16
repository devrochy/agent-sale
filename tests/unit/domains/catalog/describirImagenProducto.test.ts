import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsearDescripcion } from "../../../../src/domains/catalog/describirImagenProducto.js";

// Mismo criterio que ocrComprobante.test.ts: mockear el SDK entero,
// capturando los args del constructor para poder afirmar el timeout.
const mockCreate = vi.fn();
const mockConstructor = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
    constructor(opts: unknown) {
      mockConstructor(opts);
    }
  },
}));

const { describirImagenProducto } = await import("../../../../src/domains/catalog/describirImagenProducto.js");

const ANTHROPIC_CONFIG = { providerKey: "anthropic" as const, apiKey: "sk-ant-test", model: "claude-sonnet-5" };

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("describirImagenProducto", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockConstructor.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("construye el cliente con la key/timeout del config recibido (proveedor Anthropic, default)", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: '{"producto": "casco integral negro"}' }] });

    await describirImagenProducto(Buffer.from("imagen-falsa"), "image/png", ANTHROPIC_CONFIG);

    expect(mockConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-ant-test", timeout: expect.any(Number) }),
    );
  });

  it("describe el producto igual si el proveedor elegido es Gemini (el parseo no depende del proveedor)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ candidates: [{ content: { parts: [{ text: '{"producto": "guantes de cuero café"}' }] } }] }),
      ),
    );

    const resultado = await describirImagenProducto(Buffer.from("imagen-falsa"), "image/png", {
      providerKey: "gemini",
      apiKey: "AIza-test",
      model: "gemini-2.5-flash-lite",
    });

    expect(resultado).toBe("guantes de cuero café");
  });
});

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
