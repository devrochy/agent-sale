import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("analizarComprobante", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockConstructor.mockReset();
  });

  it("construye el cliente con timeout explícito (ver env.llmTimeoutMs, incidente 2026-09-13)", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: '{"monto": 50000, "cuenta_destino": "123"}' }] });

    await analizarComprobante(Buffer.from("imagen-falsa"), "image/png");

    expect(mockConstructor).toHaveBeenCalledWith(expect.objectContaining({ timeout: expect.any(Number) }));
  });

  it("extrae monto y cuenta destino de la respuesta del modelo", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: '{"monto": 50000, "cuenta_destino": "123-456"}' }] });

    const resultado = await analizarComprobante(Buffer.from("imagen-falsa"), "image/png");

    expect(resultado).toEqual({ monto: 50000, cuentaDestino: "123-456" });
  });

  it("devuelve nulls si la respuesta no es JSON parseable", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "no puedo leer esta imagen" }] });

    const resultado = await analizarComprobante(Buffer.from("imagen-falsa"), "image/png");

    expect(resultado).toEqual({ monto: null, cuentaDestino: null });
  });
});
