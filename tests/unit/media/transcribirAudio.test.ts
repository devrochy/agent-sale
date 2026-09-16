import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcribirAudio } from "../../../src/media/transcribirAudio.js";

const OPENAI_CONFIG = { apiKey: "sk-test-key", baseUrl: "https://api.openai.com/v1", model: "whisper-1" };
const GROQ_CONFIG = { apiKey: "gsk-test-key", baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" };

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("transcribirAudio", () => {
  it("manda el audio al endpoint del proveedor configurado y devuelve el texto transcripto", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ text: "Hola, tienen cascos talla M?" }));
    vi.stubGlobal("fetch", fetchMock);

    const resultado = await transcribirAudio(Buffer.from("audio-falso"), "audio/ogg; codecs=opus", OPENAI_CONFIG);

    expect(resultado).toBe("Hola, tienen cascos talla M?");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer sk-test-key",
    );
  });

  it("con el proveedor Groq, manda el audio a su baseUrl con su modelo — mismo shape de request", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ text: "Hola desde Groq" }));
    vi.stubGlobal("fetch", fetchMock);

    const resultado = await transcribirAudio(Buffer.from("audio-falso"), "audio/ogg", GROQ_CONFIG);

    expect(resultado).toBe("Hola desde Groq");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect((init as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer gsk-test-key",
    );
    const formData = (init as RequestInit).body as FormData;
    expect(formData.get("model")).toBe("whisper-large-v3-turbo");
  });

  it("manda un AbortSignal con timeout (ver env.transcriptionTimeoutMs, incidente 2026-09-13)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ text: "Hola" }));
    vi.stubGlobal("fetch", fetchMock);

    await transcribirAudio(Buffer.from("audio-falso"), "audio/ogg", OPENAI_CONFIG);

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("devuelve null (no lanza) cuando el proveedor no transcribe nada en claro", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ text: "" }));
    vi.stubGlobal("fetch", fetchMock);

    const resultado = await transcribirAudio(Buffer.from("silencio"), "audio/ogg", OPENAI_CONFIG);

    expect(resultado).toBeNull();
  });

  it("lanza si el proveedor rechaza la llamada (auth, rate limit, etc.)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: { message: "Invalid API key" } }, 401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribirAudio(Buffer.from("x"), "audio/ogg", OPENAI_CONFIG)).rejects.toThrow(/Invalid API key/);
  });

  it("lanza si no se le pasó ninguna API key, sin llamar a fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      transcribirAudio(Buffer.from("x"), "audio/ogg", { ...OPENAI_CONFIG, apiKey: "" }),
    ).rejects.toThrow(/API key configurada/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
