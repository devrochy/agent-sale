import { env } from "../../config/env.js";
import type { ContentBlock, LLMMessage, LLMProvider, ToolDefinition, TurnResponse } from "./types.js";

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

function toOpenAITools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Traduce el formato neutro (que agrupa los tool_result de un turno en un
 * único mensaje "user", igual que Anthropic) al de OpenAI, que exige un
 * mensaje "tool" independiente por cada tool_call_id.
 */
function toOpenAIMessages(systemPrompt: string, messages: LLMMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [{ role: "system", content: systemPrompt }];

  for (const message of messages) {
    if (typeof message.content === "string") {
      result.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "user") {
      const toolResults = message.content.filter(
        (block): block is Extract<ContentBlock, { type: "tool_result" }> => block.type === "tool_result",
      );
      if (toolResults.length > 0) {
        for (const block of toolResults) {
          result.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.content });
        }
        continue;
      }
      result.push({ role: "user", content: textOf(message.content) });
      continue;
    }

    const toolUses = message.content.filter(
      (block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use",
    );
    result.push({
      role: "assistant",
      content: textOf(message.content) || null,
      tool_calls: toolUses.length
        ? toolUses.map((block) => ({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          }))
        : undefined,
    });
  }

  return result;
}

function toStopReason(finishReason: string): TurnResponse["stopReason"] {
  switch (finishReason) {
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    case "stop":
    case "length":
      return "end_turn";
    default:
      return "other";
  }
}

interface ChatCompletionResponse {
  choices: Array<{ message: OpenAIMessage; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Proveedor alternativo para cualquier API compatible con el formato de
 * chat completions de OpenAI (DeepSeek, Groq, el propio OpenAI, etc.) —
 * ver ADR-010. Pensado para pruebas reales de bajo costo cuando el
 * proveedor principal (Claude, ver ADR-008) no esté disponible; no
 * reemplaza esa decisión de producción.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  async converse({
    systemPrompt,
    tools,
    messages,
  }: {
    systemPrompt: string;
    tools: ToolDefinition[];
    messages: LLMMessage[];
  }): Promise<TurnResponse> {
    const response = await fetch(`${env.llmBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.llmApiKey}`,
      },
      body: JSON.stringify({
        model: env.llmModel,
        messages: toOpenAIMessages(systemPrompt, messages),
        tools: toOpenAITools(tools),
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Error del proveedor LLM (${env.llmBaseUrl}): ${response.status} ${await response.text()}`,
      );
    }

    const body = (await response.json()) as ChatCompletionResponse;
    const choice = body.choices[0];
    if (!choice) {
      throw new Error(`Respuesta del proveedor LLM (${env.llmBaseUrl}) sin choices`);
    }

    const content: ContentBlock[] = [];
    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }
    for (const toolCall of choice.message.tool_calls ?? []) {
      content.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.function.name,
        input: JSON.parse(toolCall.function.arguments) as unknown,
      });
    }

    return {
      stopReason: toStopReason(choice.finish_reason),
      content,
      refusalCategory: choice.finish_reason === "content_filter" ? "content_filter" : null,
      usage: {
        inputTokens: body.usage.prompt_tokens,
        outputTokens: body.usage.completion_tokens,
      },
    };
  }
}
