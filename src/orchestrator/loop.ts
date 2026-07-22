import type { EscalationReason } from "../domains/escalation/escalarHumano.js";
import { escalarHumano } from "../domains/escalation/escalarHumano.js";
import { recordAudit } from "../shared/audit/auditLog.js";
import { getEscalationConfig } from "../shared/db/index.js";
import { logger } from "../shared/observability/logger.js";
import { isMontoAlto, matchKeywordEscalation, resolveEscalationConfig } from "./escalationRules.js";
import { llmProvider, type ContentBlock } from "./llm/index.js";
import { appendMessage, loadHistory, resolveConversation, updateState } from "./memory.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { TOOL_DEFINITIONS } from "./toolDefinitions.js";
import { executeTool } from "./toolExecutor.js";

// Límite de iteraciones del loop (ver docs/fase-4-motor-agente/orquestador.md):
// evita que un error de razonamiento deje al agente llamando tools indefinidamente.
const MAX_ITERATIONS = 6;

// Tools comerciales cuyo monto se compara contra el umbral de "monto alto"
// (ver docs/fase-7-escalamiento-humano/reglas-escalamiento.md).
const QUOTE_AMOUNT_TOOLS = new Set(["generar_cotizacion", "aplicar_promocion", "crear_pedido"]);

const FALLBACK_ESCALATION_MESSAGE =
  "En este momento no puedo continuar por acá — ya avisé a un asesor de ForMotos para que te contacte en breve.";

export interface TurnResult {
  // `null` cuando la conversación ya está escalada: el mensaje se guarda
  // para el asesor, pero no se reprocesa con el LLM ni se responde
  // automáticamente (ver reglas-escalamiento.md, "qué pasa después de escalar").
  responseText: string | null;
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Si el tool_result es de una tool comercial, extrae el monto relevante
 * (`total` si existe, si no `subtotal`) para la regla de monto alto. `null`
 * si la tool no aplica, o si el resultado vino con error.
 */
function extractQuoteAmount(toolName: string, toolResult: ContentBlock): number | null {
  if (
    toolResult.type !== "tool_result" ||
    toolResult.is_error ||
    !QUOTE_AMOUNT_TOOLS.has(toolName)
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(toolResult.content) as { subtotal?: number; total?: number };
    return parsed.total ?? parsed.subtotal ?? null;
  } catch {
    return null;
  }
}

async function escalateAndReply(
  tenantId: string,
  conversationId: string,
  reason: EscalationReason,
  summary: string,
): Promise<TurnResult> {
  const escalation = await escalarHumano(tenantId, conversationId, { reason, summary });
  await recordAudit(
    tenantId,
    conversationId,
    "orchestrator",
    "escalar_a_humano",
    { reason, summary },
    escalation,
  );
  logger
    .child({ tenant_id: tenantId, conversation_id: conversationId })
    .info({ event: "orchestrator.escalado", reason }, "Conversación escalada a un asesor humano");
  await appendMessage(tenantId, conversationId, "outbound", "agent", FALLBACK_ESCALATION_MESSAGE);
  await updateState(tenantId, conversationId, { step: "escalado" });
  return { responseText: FALLBACK_ESCALATION_MESSAGE };
}

/**
 * Orquesta un turno completo (ver docs/fase-4-motor-agente/orquestador.md
 * y docs/fase-7-escalamiento-humano/reglas-escalamiento.md): carga
 * memoria, aplica las reglas explícitas de escalamiento que no dependen
 * del LLM, llama al proveedor de LLM con tool calling manual, ejecuta
 * tools, persiste el resultado. `tenant_id`, `conversation_id` y
 * `customer_id` nunca se exponen al LLM como parámetros de tool — los
 * inyecta este módulo. `messageSid` se usa solo para el idempotency_key
 * de crear_pedido (ver domains/commerce/crearPedido.ts).
 */
export async function runTurn(
  tenantId: string,
  customerPhone: string,
  incomingBody: string,
  messageSid: string,
): Promise<TurnResult> {
  const { conversationId, customerId, state } = await resolveConversation(tenantId, customerPhone);
  const turnLogger = logger.child({ tenant_id: tenantId, conversation_id: conversationId });

  await appendMessage(tenantId, conversationId, "inbound", "customer", incomingBody);

  if (state.step === "escalado") {
    // El mensaje ya quedó guardado para que el asesor lo vea (vista del
    // asesor, incremento separado) — el agente no responde automáticamente
    // hasta que un humano cierre el caso.
    return { responseText: null };
  }

  const escalationConfig = resolveEscalationConfig(await getEscalationConfig(tenantId));

  const keywordMatch = matchKeywordEscalation(incomingBody, escalationConfig);
  if (keywordMatch) {
    return escalateAndReply(
      tenantId,
      conversationId,
      keywordMatch.reason,
      `El mensaje del cliente contiene el término "${keywordMatch.matchedTerm}" (regla de palabras clave).`,
    );
  }

  const messages = await loadHistory(tenantId, conversationId);
  let hadAnyToolCall = false;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    turnLogger.info({ event: "orchestrator.llm_iniciado", iteration }, "Llamada al LLM iniciada");
    const llmStartedAt = Date.now();
    const response = await llmProvider.converse({
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      messages,
    });
    turnLogger.info(
      {
        event: "orchestrator.llm_completado",
        iteration,
        latency_ms: Date.now() - llmStartedAt,
        stop_reason: response.stopReason,
        usage: response.usage,
      },
      "Llamada al LLM completada",
    );

    await recordAudit(tenantId, conversationId, "agent", "turno_conversacion", null, {
      stop_reason: response.stopReason,
      usage: response.usage,
    });

    if (response.stopReason === "refusal") {
      await recordAudit(tenantId, conversationId, "orchestrator", "refusal", null, {
        category: response.refusalCategory ?? null,
      });
      return escalateAndReply(
        tenantId,
        conversationId,
        "queja",
        "El agente rehusó continuar la conversación (stop_reason: refusal).",
      );
    }

    messages.push({ role: "assistant", content: response.content });
    await appendMessage(
      tenantId,
      conversationId,
      "outbound",
      "agent",
      extractText(response.content),
      response.content,
    );

    if (response.stopReason === "tool_use") {
      hadAnyToolCall = true;
      const toolUseBlocks = response.content.filter(
        (block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use",
      );
      const toolResults: ContentBlock[] = [];
      let montoAltoAmount: number | null = null;
      for (const toolUse of toolUseBlocks) {
        const toolResult = await executeTool(
          tenantId,
          conversationId,
          customerId,
          messageSid,
          toolUse,
        );
        toolResults.push(toolResult);
        const amount = extractQuoteAmount(toolUse.name, toolResult);
        if (amount !== null && isMontoAlto(amount, escalationConfig)) {
          montoAltoAmount = amount;
        }
      }
      messages.push({ role: "user", content: toolResults });
      await appendMessage(tenantId, conversationId, "inbound", "agent", "", toolResults);

      if (montoAltoAmount !== null) {
        return escalateAndReply(
          tenantId,
          conversationId,
          "monto_alto",
          `El monto de la cotización/pedido ($${montoAltoAmount}) supera el umbral configurado ($${escalationConfig.montoAltoThreshold}).`,
        );
      }

      continue;
    }

    if (response.stopReason === "other") {
      continue;
    }

    // end_turn: el turno terminó sin escalar. Cuenta como "intento sin
    // resolver" si no se usó ninguna tool (ver reglas-escalamiento.md,
    // regla de intentos fallidos) — se resetea apenas el agente sí se
    // apoya en una tool real.
    const previousCount =
      typeof state.turnos_sin_resolver === "number" ? state.turnos_sin_resolver : 0;
    const turnosSinResolver = hadAnyToolCall ? 0 : previousCount + 1;

    if (turnosSinResolver >= escalationConfig.maxIntentosFallidos) {
      return escalateAndReply(
        tenantId,
        conversationId,
        "intentos_fallidos",
        `El agente respondió ${turnosSinResolver} turnos consecutivos sin usar ninguna tool para resolver la necesidad del cliente.`,
      );
    }

    const responseText = extractText(response.content);
    await updateState(tenantId, conversationId, {
      step: "resuelto",
      turnos_sin_resolver: turnosSinResolver,
    });
    return { responseText };
  }

  return escalateAndReply(
    tenantId,
    conversationId,
    "intentos_fallidos",
    "El agente alcanzó el límite de iteraciones de tool calling sin resolver.",
  );
}
