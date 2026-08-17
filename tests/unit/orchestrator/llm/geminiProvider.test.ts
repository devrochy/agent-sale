import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "../../../../src/orchestrator/llm/geminiProvider.js";
import type { LLMMessage } from "../../../../src/orchestrator/llm/types.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("GeminiProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("traduce una respuesta de texto simple a end_turn", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "Hola!" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
      }),
    );

    const provider = new GeminiProvider({ apiKey: "test-key", model: "gemini-2.5-flash" });
    const result = await provider.converse({
      systemPrompt: ["Sos un asistente."],
      tools: [],
      messages: [{ role: "user", content: "Hola" }],
    });

    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toEqual([{ type: "text", text: "Hola!" }]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 3 });

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain("gemini-2.5-flash:generateContent?key=test-key");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.system_instruction).toEqual({ parts: [{ text: "Sos un asistente." }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Hola" }] }]);
    expect(body.tools).toBeUndefined();
  });

  it("detecta tool_use por la presencia de functionCall, no por finishReason", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { parts: [{ functionCall: { name: "consultar_inventario", args: { query: "cascos" } } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 },
      }),
    );

    const provider = new GeminiProvider({ apiKey: "test-key" });
    const result = await provider.converse({
      systemPrompt: ["..."],
      tools: [{ name: "consultar_inventario", description: "...", inputSchema: { type: "object" } }],
      messages: [{ role: "user", content: "tienen cascos?" }],
    });

    expect(result.stopReason).toBe("tool_use");
    expect(result.content).toHaveLength(1);
    const block = result.content[0]!;
    expect(block.type).toBe("tool_use");
    if (block.type === "tool_use") {
      expect(block.name).toBe("consultar_inventario");
      expect(block.input).toEqual({ query: "cascos" });
      expect(typeof block.id).toBe("string");
      expect(block.id.length).toBeGreaterThan(0);
    }
  });

  it("reconstruye el nombre de la función en un functionResponse a partir del tool_use_id previo", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "Listo" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      }),
    );

    const provider = new GeminiProvider({ apiKey: "test-key" });
    const messages: LLMMessage[] = [
      { role: "user", content: "tienen cascos?" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "consultar_inventario", input: { query: "cascos" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: '{"matches":[]}' }],
      },
    ];

    await provider.converse({ systemPrompt: ["..."], tools: [], messages });

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.contents[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "consultar_inventario", response: { matches: [] } } }],
    });
  });

  it("mapea SAFETY a refusal", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 },
      }),
    );

    const provider = new GeminiProvider({ apiKey: "test-key" });
    const result = await provider.converse({
      systemPrompt: ["..."],
      tools: [],
      messages: [{ role: "user", content: "hola" }],
    });

    expect(result.stopReason).toBe("refusal");
    expect(result.refusalCategory).toBe("SAFETY");
  });

  it("lanza si la respuesta HTTP no es ok", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "bad key" }, false, 401));

    const provider = new GeminiProvider({ apiKey: "key-invalida" });
    await expect(
      provider.converse({ systemPrompt: ["..."], tools: [], messages: [{ role: "user", content: "hola" }] }),
    ).rejects.toThrow(/401/);
  });
});
