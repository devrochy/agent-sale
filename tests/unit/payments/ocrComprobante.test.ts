import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mismo criterio que anthropicProvider.test.ts: mockear el SDK entero,
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

const { analizarComprobante } = await import("../../../src/payments/ocrComprobante.js");

const ANTHROPIC_CONFIG = { providerKey: "anthropic" as const, apiKey: "sk-ant-test", model: "claude-sonnet-5" };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("analizarComprobante", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockConstructor.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("construye el cliente de Anthropic con la key/timeout del config recibido, no de env", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: '{"monto": 50000, "cuenta_destino": "123"}' }] });

    await analizarComprobante(Buffer.from("imagen-falsa"), "image/png", ANTHROPIC_CONFIG);

    expect(mockConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-ant-test", timeout: expect.any(Number) }),
    );
  });

  it("extrae monto y cuenta destino de la respuesta del modelo (proveedor Anthropic)", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: '{"monto": 50000, "cuenta_destino": "123-456"}' }] });

    const resultado = await analizarComprobante(Buffer.from("imagen-falsa"), "image/png", ANTHROPIC_CONFIG);

    expect(resultado).toEqual({ monto: 50000, cuentaDestino: "123-456" });
  });

  it("devuelve nulls si la respuesta no es JSON parseable", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "no puedo leer esta imagen" }] });

    const resultado = await analizarComprobante(Buffer.from("imagen-falsa"), "image/png", ANTHROPIC_CONFIG);

    expect(resultado).toEqual({ monto: null, cuentaDestino: null });
  });

  it("extrae monto y cuenta destino igual si el proveedor elegido es Gemini (el parseo no depende del proveedor)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          candidates: [{ content: { parts: [{ text: '{"monto": 75000, "cuenta_destino": "999-111"}' }] } }],
        }),
      ),
    );

    const resultado = await analizarComprobante(Buffer.from("imagen-falsa"), "image/png", {
      providerKey: "gemini",
      apiKey: "AIza-test",
      model: "gemini-2.5-flash-lite",
    });

    expect(resultado).toEqual({ monto: 75000, cuentaDestino: "999-111" });
    expect(mockConstructor).not.toHaveBeenCalled(); // no instancia el SDK de Anthropic para este proveedor
  });

  it("extrae monto y cuenta destino igual si el proveedor elegido es DeepSeek", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: '{"monto": 30000, "cuenta_destino": "555-666"}' } }],
        }),
      ),
    );

    const resultado = await analizarComprobante(Buffer.from("imagen-falsa"), "image/png", {
      providerKey: "deepseek",
      apiKey: "sk-deepseek-test",
      model: "deepseek-flash",
    });

    expect(resultado).toEqual({ monto: 30000, cuentaDestino: "555-666" });
  });
});
