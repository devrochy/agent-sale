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
    // Array ordenado de bloques de texto plano del system prompt (Fase
    // 11.4 extendida, ver ADR-021) — ej. [bloque compartido, bloque de
    // tono del tenant]. Sin metadata de cache acá a propósito: eso es
    // Anthropic-específico (cache_control), cada provider decide cómo
    // traducir el array (Anthropic le pone un breakpoint por bloque;
    // los demás simplemente lo concatenan, su caching ya es opaco).
    systemPrompt: string[];
    tools: ToolDefinition[];
    messages: LLMMessage[];
    /**
     * Fuerza que esta respuesta puntual use exactamente esta tool (nunca
     * texto libre ni otra tool) — ver loop.ts, FORZAR_SIGUIENTE_TOOL.
     * Garantía de código para los tramos del flujo de venta que el prompt
     * ya pide encadenar "sin escribir nada entre medio" (systemPrompt.ts)
     * pero que el modelo no respeta de forma consistente (confirmado en
     * logs reales: DeepSeek terminó preguntando el método de pago por
     * texto en vez de llamar "preguntar_metodo_pago" en 4 de 4 pedidos de
     * una prueba real) — mismo criterio que esTurnoSilencioso: no
     * reemplaza la instrucción del prompt, la vuelve imposible de saltar.
     * `undefined` es el comportamiento de siempre (el modelo elige).
     */
    forceToolName?: string;
  }): Promise<TurnResponse>;
}
