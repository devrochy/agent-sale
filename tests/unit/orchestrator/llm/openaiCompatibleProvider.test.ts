import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../../../../src/orchestrator/llm/openaiCompatibleProvider.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("OpenAICompatibleProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("traduce una respuesta de tool_calls a tool_use", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "consultar_inventario", arguments: '{"query":"cascos"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );

    const provider = new OpenAICompatibleProvider({ apiKey: "k", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" });
    const result = await provider.converse({
      systemPrompt: ["Sos un asistente."],
      tools: [{ name: "consultar_inventario", description: "...", inputSchema: { type: "object" } }],
      messages: [{ role: "user", content: "tienen cascos?" }],
    });

    expect(result.stopReason).toBe("tool_use");
    expect(result.content).toEqual([
      { type: "tool_use", id: "call_1", name: "consultar_inventario", input: { query: "cascos" } },
    ]);
  });

  it("sin forceToolName no manda tool_choice", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "Hola!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );

    const provider = new OpenAICompatibleProvider({ apiKey: "k" });
    await provider.converse({ systemPrompt: ["..."], tools: [], messages: [{ role: "user", content: "hola" }] });

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.tool_choice).toBeUndefined();
  });

  it("forceToolName arma tool_choice type function con el nombre exacto", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "preguntar_metodo_pago", arguments: '{"quote_id":"q1"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );

    const provider = new OpenAICompatibleProvider({ apiKey: "k" });
    await provider.converse({
      systemPrompt: ["..."],
      tools: [{ name: "preguntar_metodo_pago", description: "...", inputSchema: { type: "object" } }],
      messages: [{ role: "user", content: "quiero comprarlo" }],
      forceToolName: "preguntar_metodo_pago",
    });

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "preguntar_metodo_pago" } });
  });

  it("lanza si la respuesta HTTP no es ok", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "bad key" }, false, 401));

    const provider = new OpenAICompatibleProvider({ apiKey: "key-invalida" });
    await expect(
      provider.converse({ systemPrompt: ["..."], tools: [], messages: [{ role: "user", content: "hola" }] }),
    ).rejects.toThrow(/401/);
  });
});
