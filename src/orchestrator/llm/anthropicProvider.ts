import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env.js";
import type { ContentBlock, LLMMessage, LLMProvider, ToolDefinition, TurnResponse } from "./types.js";

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

function toStopReason(stopReason: string | null): TurnResponse["stopReason"] {
  switch (stopReason) {
    case "tool_use":
      return "tool_use";
    case "refusal":
      return "refusal";
    case "end_turn":
      return "end_turn";
    default:
      // Incluye pause_turn (orquestación server-side de tools que no
      // usamos todavía) y cualquier otro valor: el loop simplemente
      // vuelve a llamar al proveedor, igual que antes de esta abstracción.
      return "other";
  }
}

export interface AnthropicProviderConfig {
  /** Sin valor, usa env.anthropicApiKey (comportamiento de siempre). Con valor, la key BYOK del tenant (Fase 11.4). */
  apiKey?: string;
  /** Sin valor, usa "claude-sonnet-5" (ADR-008). */
  model?: string;
}

/**
 * Proveedor por defecto (ver ADR-008): Claude Sonnet 5 con thinking
 * adaptativo, effort medio y prompt caching sobre el bloque de system.
 * El contrato neutro ya coincide con el shape de la API de Anthropic, así
 * que esta implementación es casi un passthrough.
 */
export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(config: AnthropicProviderConfig = {}) {
    this.client = new Anthropic({ apiKey: config.apiKey ?? env.anthropicApiKey });
    this.model = config.model ?? "claude-sonnet-5";
  }

  async converse({
    systemPrompt,
    tools,
    messages,
  }: {
    systemPrompt: string[];
    tools: ToolDefinition[];
    messages: LLMMessage[];
  }): Promise<TurnResponse> {
    // Haiku no soporta thinking adaptativo ni effort (confirmado en vivo:
    // la API rechaza la llamada con "adaptive thinking is not supported
    // on this model") — a diferencia de Sonnet/Opus. Antes de la Fase
    // 11.4 esto no se notaba porque Sonnet 5 era el único modelo posible;
    // ahora que "Cerebro del bot" (ADR-023) puede elegir Haiku para
    // mensajes triviales, hay que detectarlo y omitir esas opciones.
    const supportsAdaptiveThinking = !this.model.includes("haiku");

    // Un breakpoint de cache_control por bloque (ver ADR-021): el bloque
    // compartido (idéntico para todos los tenants) y el bloque de tono
    // (idéntico entre tenants que eligen el mismo tono) son checkpoints
    // de prefijo independientes — invalidar uno no invalida el anterior.
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      ...(supportsAdaptiveThinking
        ? { thinking: { type: "adaptive" as const }, output_config: { effort: "medium" as const } }
        : {}),
      system: systemPrompt.map((text) => ({
        type: "text" as const,
        text,
        cache_control: { type: "ephemeral" as const },
      })),
      tools: toAnthropicTools(tools),
      messages: messages as Anthropic.MessageParam[],
    });

    return {
      stopReason: toStopReason(response.stop_reason),
      content: response.content as unknown as ContentBlock[],
      refusalCategory: response.stop_details?.category ?? null,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? undefined,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? undefined,
      },
    };
  }
}
