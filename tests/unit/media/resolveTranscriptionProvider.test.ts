import { beforeEach, describe, expect, it, vi } from "vitest";

// resolveTranscriptionProvider (Fase de proveedores configurables de OCR/
// transcripción): mismo contrato que resolveVisionProvider/
// resolveLlmProvider, más el puente con la key legada de OpenAI
// (migración 0061) — el punto más delicado del diseño, ver
// settingsDirectory.ts → getOpenAiConfig/getTranscriptionConfig.
const getOpenAiConfig = vi.fn();
const getTranscriptionConfig = vi.fn();
vi.mock("../../../src/shared/db/settingsDirectory.js", () => ({ getOpenAiConfig, getTranscriptionConfig }));

// OPENAI_API_KEY es opcional (a diferencia de ANTHROPIC_API_KEY, required())
// y no está seteada en este entorno de test — se mockea explícito en vez de
// depender de qué haya en .env, para que "cae a la key de sistema" sea
// determinístico. Se parte del módulo real (importActual) para no perder
// el resto de env.* que transcribirAudio.ts/fetchWithTimeout.ts necesitan
// (ej. env.transcriptionTimeoutMs).
vi.mock("../../../src/config/env.js", async () => {
  const real = await vi.importActual<{ env: Record<string, unknown> }>("../../../src/config/env.js");
  return { env: { ...real.env, openaiApiKey: "sk-sistema-test" } };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { resolveTranscriptionProvider, testTranscriptionConfig } = await import(
  "../../../src/media/resolveTranscriptionProvider.js"
);

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("resolveTranscriptionProvider", () => {
  beforeEach(() => {
    getOpenAiConfig.mockReset();
    getTranscriptionConfig.mockReset();
  });

  it("sin config nueva NI key legada, resuelve a Automático (env.openaiApiKey) — cero regresión", async () => {
    getTranscriptionConfig.mockResolvedValue({ provider: null, model: null, apiKey: null });
    getOpenAiConfig.mockResolvedValue({ apiKey: null });

    const resuelto = await resolveTranscriptionProvider();

    expect(resuelto.providerKey).toBe("env-default");
    expect(resuelto.model).toBe("whisper-1");
    expect(resuelto.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("puente con la key legada: sin config nueva pero CON key ya guardada por el panel viejo, resuelve como 'openai' explícito", async () => {
    getTranscriptionConfig.mockResolvedValue({ provider: null, model: null, apiKey: null });
    getOpenAiConfig.mockResolvedValue({ apiKey: "sk-legado-real" });

    const resuelto = await resolveTranscriptionProvider();

    expect(resuelto).toEqual({
      providerKey: "openai",
      apiKey: "sk-legado-real",
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
    });
    // No se llamó nunca a getTranscriptionConfig para nada más que el
    // chequeo inicial — el puente no dispara ninguna escritura.
  });

  it("con config nueva explícita (Groq + BYOK propio), usa esa key sin tocar la legada", async () => {
    getTranscriptionConfig.mockResolvedValue({
      provider: "groq",
      model: "whisper-large-v3-turbo",
      apiKey: "gsk-propia",
    });

    const resuelto = await resolveTranscriptionProvider();

    expect(resuelto).toEqual({
      providerKey: "groq",
      apiKey: "gsk-propia",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3-turbo",
    });
    expect(getOpenAiConfig).not.toHaveBeenCalled();
  });

  it("con proveedor 'openai' explícito pero sin key nueva, cae a la key de sistema (env.openaiApiKey)", async () => {
    getTranscriptionConfig.mockResolvedValue({ provider: "openai", model: "whisper-1", apiKey: null });

    const resuelto = await resolveTranscriptionProvider();

    expect(resuelto).toEqual({
      providerKey: "openai",
      apiKey: "sk-sistema-test",
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
    });
  });

  it("con proveedor 'groq' explícito y sin key propia, lanza (no hay key de sistema para Groq)", async () => {
    getTranscriptionConfig.mockResolvedValue({ provider: "groq", model: "whisper-large-v3-turbo", apiKey: null });

    await expect(resolveTranscriptionProvider()).rejects.toThrow(/Groq/);
  });
});

describe("testTranscriptionConfig", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("no lanza si la combinación proveedor+modelo+key funciona", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: "" }));

    await expect(
      testTranscriptionConfig({ provider: "groq", model: "whisper-large-v3-turbo", apiKey: "gsk-test" }),
    ).resolves.toBeUndefined();

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
  });

  it("lanza si no hay key propia ni key de sistema para el proveedor elegido (groq)", async () => {
    await expect(
      testTranscriptionConfig({ provider: "groq", model: "whisper-large-v3-turbo", apiKey: null }),
    ).rejects.toThrow(/Groq/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
