import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock del SDK de Anthropic: solo necesitamos que `new Anthropic(...)`
// devuelva un objeto con `messages.create` espiable — el resto del
// comportamiento real de la API no es responsabilidad de este provider.
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

import { AnthropicProvider } from "../../../../src/orchestrator/llm/anthropicProvider.js";

const BASE_RESPONSE = {
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id: "toolu_1", name: "preguntar_metodo_pago", input: { quote_id: "q1" } }],
  stop_details: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

describe("AnthropicProvider", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(BASE_RESPONSE);
  });

  it("sin forceToolName manda thinking adaptativo y no manda tool_choice (Sonnet)", async () => {
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-5" });
    await provider.converse({
      systemPrompt: ["Sos un asistente."],
      tools: [{ name: "preguntar_metodo_pago", description: "...", inputSchema: { type: "object" } }],
      messages: [{ role: "user", content: "quiero comprarlo" }],
    });

    const params = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.tool_choice).toBeUndefined();
  });

  it("forceToolName arma tool_choice type tool y desactiva thinking (no compatible con tool_choice forzado)", async () => {
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-5" });
    await provider.converse({
      systemPrompt: ["..."],
      tools: [{ name: "preguntar_metodo_pago", description: "...", inputSchema: { type: "object" } }],
      messages: [{ role: "user", content: "quiero comprarlo" }],
      forceToolName: "preguntar_metodo_pago",
    });

    const params = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.tool_choice).toEqual({ type: "tool", name: "preguntar_metodo_pago" });
    expect(params.thinking).toBeUndefined();
    expect(params.output_config).toBeUndefined();
  });

  it("traduce la respuesta a TurnResponse (tool_use)", async () => {
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-5" });
    const result = await provider.converse({
      systemPrompt: ["..."],
      tools: [{ name: "preguntar_metodo_pago", description: "...", inputSchema: { type: "object" } }],
      messages: [{ role: "user", content: "quiero comprarlo" }],
      forceToolName: "preguntar_metodo_pago",
    });

    expect(result.stopReason).toBe("tool_use");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});
