import { beforeEach, describe, expect, it, vi } from "vitest";

// resolveVisionProvider (Fase de proveedores configurables de OCR/visión):
// mismo contrato que resolveLlmProvider — sin config guardada, comportamiento
// idéntico al hardcode de antes de esta feature (Claude + env.anthropicApiKey).
const getOcrConfig = vi.fn();
vi.mock("../../../src/shared/db/settingsDirectory.js", () => ({ getOcrConfig }));

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
    constructor() {}
  },
}));

const { resolveVisionProvider, testVisionConfig } = await import("../../../src/vision/index.js");

describe("resolveVisionProvider", () => {
  beforeEach(() => {
    getOcrConfig.mockReset();
  });

  it("sin config guardada, resuelve a Anthropic con la key de sistema (env.anthropicApiKey) — cero regresión", async () => {
    getOcrConfig.mockResolvedValue({ provider: null, model: null, apiKey: null });

    const resuelto = await resolveVisionProvider();

    expect(resuelto.providerKey).toBe("anthropic");
    expect(resuelto.model).toBe("claude-sonnet-5");
    // env.anthropicApiKey viene del .env de test — solo confirmamos que no
    // quedó vacío, el valor exacto no es parte del contrato.
    expect(resuelto.apiKey).toBeTruthy();
  });

  it("con config guardada y BYOK propio, usa esa key sin tocar la de sistema", async () => {
    getOcrConfig.mockResolvedValue({ provider: "gemini", model: "gemini-2.5-flash-lite", apiKey: "AIza-propia" });

    const resuelto = await resolveVisionProvider();

    expect(resuelto).toEqual({ providerKey: "gemini", model: "gemini-2.5-flash-lite", apiKey: "AIza-propia" });
  });

  it("con proveedor 'anthropic' explícito pero sin key propia, cae a la key de sistema", async () => {
    getOcrConfig.mockResolvedValue({ provider: "anthropic", model: "claude-sonnet-5", apiKey: null });

    const resuelto = await resolveVisionProvider();

    expect(resuelto.providerKey).toBe("anthropic");
    expect(resuelto.apiKey).toBeTruthy();
  });

  it("con proveedor 'deepseek'/'gemini' sin key propia, lanza (no hay key de sistema para esos)", async () => {
    getOcrConfig.mockResolvedValue({ provider: "deepseek", model: "deepseek-flash", apiKey: null });

    await expect(resolveVisionProvider()).rejects.toThrow(/DeepSeek/);
  });
});

describe("testVisionConfig", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("no lanza si la combinación proveedor+modelo+key funciona", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await expect(
      testVisionConfig({ provider: "anthropic", model: "claude-sonnet-5", apiKey: "sk-ant-test" }),
    ).resolves.toBeUndefined();
  });

  it("lanza si no hay key propia ni key de sistema para el proveedor elegido", async () => {
    await expect(
      testVisionConfig({ provider: "deepseek", model: "deepseek-flash", apiKey: null }),
    ).rejects.toThrow(/DeepSeek/);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
