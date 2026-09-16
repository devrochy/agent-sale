import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/vision/callVisionModel.js", () => ({
  callVisionModel: vi.fn(),
}));

import { callVisionModel } from "../../../src/vision/callVisionModel.js";
import { clasificarImagenEntrante } from "../../../src/vision/clasificarImagenEntrante.js";

const CONFIG = { providerKey: "anthropic" as const, apiKey: "sk-test", model: "claude-sonnet-5" };

describe("clasificarImagenEntrante", () => {
  beforeEach(() => {
    vi.mocked(callVisionModel).mockReset();
  });

  it('el modelo responde {"tipo":"producto"} -> "producto"', async () => {
    vi.mocked(callVisionModel).mockResolvedValueOnce('{"tipo": "producto"}');

    const resultado = await clasificarImagenEntrante(Buffer.from("img"), "image/jpeg", CONFIG);

    expect(resultado).toBe("producto");
  });

  it('el modelo responde {"tipo":"comprobante"} -> "comprobante"', async () => {
    vi.mocked(callVisionModel).mockResolvedValueOnce('{"tipo": "comprobante"}');

    const resultado = await clasificarImagenEntrante(Buffer.from("img"), "image/jpeg", CONFIG);

    expect(resultado).toBe("comprobante");
  });

  it("respuesta ambigua/sin JSON -> fail-safe \"comprobante\"", async () => {
    vi.mocked(callVisionModel).mockResolvedValueOnce("no sé qué es esto");

    const resultado = await clasificarImagenEntrante(Buffer.from("img"), "image/jpeg", CONFIG);

    expect(resultado).toBe("comprobante");
  });

  it("el modelo no devuelve texto (null) -> fail-safe \"comprobante\"", async () => {
    vi.mocked(callVisionModel).mockResolvedValueOnce(null);

    const resultado = await clasificarImagenEntrante(Buffer.from("img"), "image/jpeg", CONFIG);

    expect(resultado).toBe("comprobante");
  });

  it("la llamada de visión falla (red, key inválida) -> fail-safe \"comprobante\", no se propaga el error", async () => {
    vi.mocked(callVisionModel).mockRejectedValueOnce(new Error("timeout"));

    const resultado = await clasificarImagenEntrante(Buffer.from("img"), "image/jpeg", CONFIG);

    expect(resultado).toBe("comprobante");
  });
});
