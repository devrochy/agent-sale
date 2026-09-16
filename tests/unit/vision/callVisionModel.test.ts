import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mismo criterio que ocrComprobante.test.ts: mockear el SDK de Anthropic
// entero para la rama "anthropic"; las ramas "gemini"/"deepseek" hablan
// por fetch directo, se mockea el global.
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

const { callVisionModel } = await import("../../../src/vision/callVisionModel.js");

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("callVisionModel", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockConstructor.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("proveedor anthropic", () => {
    it("manda la imagen + prompt a Claude y devuelve el texto de la respuesta", async () => {
      mockCreate.mockResolvedValue({ content: [{ type: "text", text: "resultado de claude" }] });

      const resultado = await callVisionModel(
        { providerKey: "anthropic", apiKey: "sk-ant-test", model: "claude-sonnet-5" },
        Buffer.from("imagen"),
        "image/png",
        "describime esto",
        100,
      );

      expect(resultado).toBe("resultado de claude");
      expect(mockConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "sk-ant-test", timeout: expect.any(Number) }),
      );
      const params = mockCreate.mock.calls[0]![0] as { model: string; max_tokens: number };
      expect(params.model).toBe("claude-sonnet-5");
      expect(params.max_tokens).toBe(100);
    });

    it("devuelve null si la respuesta no tiene ningún bloque de texto", async () => {
      mockCreate.mockResolvedValue({ content: [] });

      const resultado = await callVisionModel(
        { providerKey: "anthropic", apiKey: "sk-ant-test", model: "claude-sonnet-5" },
        Buffer.from("imagen"),
        "image/png",
        "describime esto",
        100,
      );

      expect(resultado).toBeNull();
    });
  });

  describe("proveedor gemini", () => {
    it("manda la imagen inline + prompt a generateContent y devuelve el texto", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({ candidates: [{ content: { parts: [{ text: "resultado de gemini" }] } }] }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const resultado = await callVisionModel(
        { providerKey: "gemini", apiKey: "AIza-test", model: "gemini-2.5-flash-lite" },
        Buffer.from("imagen"),
        "image/png",
        "describime esto",
        100,
      );

      expect(resultado).toBe("resultado de gemini");
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toContain("gemini-2.5-flash-lite:generateContent?key=AIza-test");
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    });

    it("lanza si la respuesta HTTP no es ok", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "bad key" }, false, 401)));

      await expect(
        callVisionModel(
          { providerKey: "gemini", apiKey: "AIza-invalida", model: "gemini-2.5-flash-lite" },
          Buffer.from("imagen"),
          "image/png",
          "describime esto",
          100,
        ),
      ).rejects.toThrow(/401/);
    });

    it("devuelve null si no hay ninguna parte de texto en la respuesta", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [] } }] })));

      const resultado = await callVisionModel(
        { providerKey: "gemini", apiKey: "AIza-test", model: "gemini-2.5-flash-lite" },
        Buffer.from("imagen"),
        "image/png",
        "describime esto",
        100,
      );

      expect(resultado).toBeNull();
    });
  });

  describe("proveedor deepseek", () => {
    it("manda la imagen como image_url (data URI) + prompt a chat/completions y devuelve el texto", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "resultado de deepseek" } }] }));
      vi.stubGlobal("fetch", fetchMock);

      const resultado = await callVisionModel(
        { providerKey: "deepseek", apiKey: "sk-deepseek-test", model: "deepseek-flash" },
        Buffer.from("imagen"),
        "image/png",
        "describime esto",
        100,
      );

      expect(resultado).toBe("resultado de deepseek");
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://api.deepseek.com/chat/completions");
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.messages[0].content[0]).toMatchObject({ type: "image_url" });
      expect(body.messages[0].content[0].image_url.url).toContain("data:image/png;base64,");
      // deepseek-flash razona por defecto y ese razonamiento consume el
      // mismo `max_tokens` que la respuesta — sin desactivarlo, el modelo
      // agota el presupuesto pensando y nunca escribe el JSON de respuesta
      // (confirmado contra la API real, ver comentario en callVisionModel.ts).
      expect(body.thinking).toEqual({ type: "disabled" });
    });

    it("lanza si la respuesta HTTP no es ok", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "bad key" }, false, 401)));

      await expect(
        callVisionModel(
          { providerKey: "deepseek", apiKey: "sk-invalida", model: "deepseek-flash" },
          Buffer.from("imagen"),
          "image/png",
          "describime esto",
          100,
        ),
      ).rejects.toThrow(/401/);
    });
  });
});
