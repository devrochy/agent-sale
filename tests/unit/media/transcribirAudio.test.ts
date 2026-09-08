import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcribirAudio } from "../../../src/media/transcribirAudio.js";

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
  it("manda el audio a Whisper y devuelve el texto transcripto", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ text: "Hola, tienen cascos talla M?" }));
    vi.stubGlobal("fetch", fetchMock);

    const resultado = await transcribirAudio(Buffer.from("audio-falso"), "audio/ogg; codecs=opus", "sk-test-key");

    expect(resultado).toBe("Hola, tienen cascos talla M?");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer sk-test-key",
    );
  });

  it("devuelve null (no lanza) cuando Whisper no transcribe nada en claro", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ text: "" }));
    vi.stubGlobal("fetch", fetchMock);

    const resultado = await transcribirAudio(Buffer.from("silencio"), "audio/ogg", "sk-test-key");

    expect(resultado).toBeNull();
  });

  it("lanza si OpenAI rechaza la llamada (auth, rate limit, etc.)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: { message: "Invalid API key" } }, 401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribirAudio(Buffer.from("x"), "audio/ogg", "sk-test-key")).rejects.toThrow(/Invalid API key/);
  });

  it("lanza si no se le pasó ninguna API key, sin llamar a fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribirAudio(Buffer.from("x"), "audio/ogg", "")).rejects.toThrow(/OPENAI_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
