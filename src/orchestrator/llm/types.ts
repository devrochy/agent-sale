/**
 * Contrato neutro entre el orquestador y el proveedor de LLM (ver
 * docs/fase-4-motor-agente/adrs/ADR-010-abstraccion-proveedor-llm.md). El
 * shape de los content blocks coincide a propósito con el de la API de
 * Anthropic (ya persistido en `messages.tool_calls`) para que el
 * proveedor por defecto (Claude) no necesite traducción; el que sí
 * traduce es cada proveedor alternativo (ver openaiCompatibleProvider.ts).
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface LLMMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type StopReason = "tool_use" | "end_turn" | "refusal" | "other";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface TurnResponse {
  stopReason: StopReason;
  content: ContentBlock[];
  refusalCategory?: string | null;
  usage: Usage;
}

export interface LLMProvider {
  converse(params: {
    systemPrompt: string;
    tools: ToolDefinition[];
    messages: LLMMessage[];
  }): Promise<TurnResponse>;
}
