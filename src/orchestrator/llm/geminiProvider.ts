import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import type { ContentBlock, LLMMessage, LLMProvider, ToolDefinition, TurnResponse } from "./types.js";

// Traduce el contrato neutro al formato de la API de Gemini
// (generateContent) — shape completamente distinto al de chat completions
// que ya cubre openaiCompatibleProvider.ts, por eso es la única family que
// necesita una implementación nueva (ver catalog.ts, ADR-020).

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: unknown };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

function toGeminiTools(tools: ToolDefinition[]) {
  if (tools.length === 0) {
    return undefined;
  }
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    },
  ];
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** functionResponse.response de Gemini espera un objeto, no el string plano que guarda tool_result.content — con contenido no-JSON (raro) se envuelve en vez de fallar. */
function toFunctionResponsePayload(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return { result: content };
  }
}

/**
 * Gemini no trae un id de function call en su respuesta (a diferencia de
 * `tool_use.id` de Anthropic o `tool_calls[].id` de OpenAI) — correlaciona
 * por nombre. El contrato neutro sí necesita un id (lo usa loop.ts para
 * emparejar tool_use con tool_result), así que este provider genera uno
 * sintético al traducir la respuesta y lo recuerda por nombre para poder
 * reconstruir el functionResponse cuando el historial completo se vuelve
 * a traducir en el siguiente turno.
 */
function toGeminiContents(messages: LLMMessage[]): GeminiContent[] {
  const result: GeminiContent[] = [];
  const toolNameById = new Map<string, string>();

  for (const message of messages) {
    if (typeof message.content === "string") {
      result.push({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] });
      continue;
    }

    if (message.role === "assistant") {
      const parts: GeminiPart[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text) {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          toolNameById.set(block.id, block.name);
          parts.push({ functionCall: { name: block.name, args: block.input } });
        }
      }
      if (parts.length > 0) {
        result.push({ role: "model", parts });
      }
      continue;
    }

    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: "tool_result" }> => block.type === "tool_result",
    );
    if (toolResults.length > 0) {
      result.push({
        role: "user",
        parts: toolResults.map((block) => ({
          functionResponse: {
            name: toolNameById.get(block.tool_use_id) ?? block.tool_use_id,
            response: toFunctionResponsePayload(block.content),
          },
        })),
      });
      continue;
    }
    result.push({ role: "user", parts: [{ text: textOf(message.content) }] });
  }

  return result;
}

/**
 * Gemini no distingue "terminé porque llamé una tool" con un finishReason
 * propio (usa "STOP" igual que un turno de texto normal) — la señal real
 * es la presencia de partes `functionCall` en la respuesta.
 */
function toStopReason(finishReason: string | undefined, hasFunctionCall: boolean): TurnResponse["stopReason"] {
  if (hasFunctionCall) {
    return "tool_use";
  }
  switch (finishReason) {
    case "STOP":
    case "MAX_TOKENS":
      return "end_turn";
    case "SAFETY":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
      return "refusal";
    default:
      return "other";
  }
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args?: unknown } }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export interface GeminiProviderConfig {
  /** Sin valor, usa env.geminiApiKey (vacío por default — Gemini no es el proveedor de sistema, ver env.ts). */
  apiKey?: string;
  model?: string;
}

export class GeminiProvider implements LLMProvider {
  constructor(private readonly config: GeminiProviderConfig = {}) {}

  async converse({
    systemPrompt,
    tools,
    messages,
  }: {
    systemPrompt: string[];
    tools: ToolDefinition[];
    messages: LLMMessage[];
  }): Promise<TurnResponse> {
    const apiKey = this.config.apiKey ?? env.geminiApiKey;
    const model = this.config.model ?? "gemini-2.5-flash";

    // Gemini tampoco tiene un equivalente a cache_control explícito — los
    // bloques del system prompt se concatenan en una sola instrucción.
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt.join("\n\n") }] },
          contents: toGeminiContents(messages),
          tools: toGeminiTools(tools),
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Error del proveedor Gemini (${model}): ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as GenerateContentResponse;
    const candidate = body.candidates?.[0];
    if (!candidate) {
      throw new Error(`Respuesta de Gemini (${model}) sin candidates`);
    }

    const content: ContentBlock[] = [];
    let hasFunctionCall = false;
    for (const part of candidate.content?.parts ?? []) {
      if (part.text) {
        content.push({ type: "text", text: part.text });
      } else if (part.functionCall) {
        hasFunctionCall = true;
        content.push({
          type: "tool_use",
          id: randomUUID(),
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        });
      }
    }

    const stopReason = toStopReason(candidate.finishReason, hasFunctionCall);

    return {
      stopReason,
      content,
      refusalCategory: stopReason === "refusal" ? (candidate.finishReason ?? null) : null,
      usage: {
        inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}
