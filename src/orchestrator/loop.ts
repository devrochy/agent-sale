import type { EscalationReason } from "../domains/escalation/escalarHumano.js";
import { escalarHumano } from "../domains/escalation/escalarHumano.js";
import { recordAudit } from "../shared/audit/auditLog.js";
import { getEscalationConfig } from "../shared/db/index.js";
import { logger } from "../shared/observability/logger.js";
import { extractMonetaryValues, verifyPriceGuardrail } from "../shared/observability/priceGuardrail.js";
import { matchKeywordEscalation, resolveEscalationConfig } from "./escalationRules.js";
import { llmProvider, type ContentBlock } from "./llm/index.js";
import { appendMessage, loadHistory, resolveConversation, updateState } from "./memory.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { TOOL_DEFINITIONS } from "./toolDefinitions.js";
import { executeTool } from "./toolExecutor.js";

// Límite de iteraciones del loop (ver docs/fase-4-motor-agente/orquestador.md):
// evita que un error de razonamiento deje al agente llamando tools indefinidamente.
const MAX_ITERATIONS = 6;

const FALLBACK_ESCALATION_MESSAGE =
  "En este momento no puedo continuar por acá — ya avisé a un asesor de ForMotos para que te contacte en breve.";

// Guardrail de precios (ver docs/fase-8-observabilidad-seguridad/guardrails.md,
// "Guardrail 1"): un solo reintento de generación antes de escalar por
// seguridad — nunca se envía al cliente un monto que no se pudo verificar.
const MAX_GUARDRAIL_RETRIES = 1;
const GUARDRAIL_RETRY_INSTRUCTION =
  "Tu respuesta anterior incluye un monto en pesos que no coincide con ningún resultado real de las tools llamadas en esta conversación. Genera una respuesta nueva usando únicamente montos que sí devolvió alguna tool.";

export interface TurnResult {
  // `null` cuando la conversación ya está escalada: el mensaje se guarda
  // para el asesor, pero no se reprocesa con el LLM ni se responde
  // automáticamente (ver reglas-escalamiento.md, "qué pasa después de escalar").
  responseText: string | null;
  // Imagen a adjuntar al mensaje de salida (ver systemPrompt.ts): regla
  // explícita, no a criterio del LLM — se llena solo cuando
  // "consultar_inventario" devolvió exactamente un match con image_url.
  mediaUrl: string | null;
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * "monto_alto" de crear_pedido significa que la tool se negó a confirmar
 * el pedido (ver crearPedido.ts: el chequeo corre *antes* del INSERT, así
 * que si devuelve esto no se creó ningún pedido ni se descontó stock —
 * evita el problema de escalar después de haber confirmado ya el pedido).
 */
function isPedidoRechazadoPorMontoAlto(toolName: string, toolResult: ContentBlock): number | null {
  if (toolName !== "crear_pedido" || toolResult.type !== "tool_result" || toolResult.is_error) {
    return null;
  }
  try {
    const parsed = JSON.parse(toolResult.content) as { status?: string; total?: number };
    return parsed.status === "monto_alto" ? parsed.total ?? null : null;
  } catch {
    return null;
  }
}

/**
 * Imagen a adjuntar al mensaje (ver TurnResult.mediaUrl): solo cuando
 * "consultar_inventario" devolvió exactamente un match con image_url —
 * con varios matches no hay forma de saber a cuál se refiere el cliente,
 * así que no se adjunta nada.
 */
function extractSingleMatchImageUrl(toolName: string, toolResult: ContentBlock): string | null {
  if (toolName !== "consultar_inventario" || toolResult.type !== "tool_result" || toolResult.is_error) {
    return null;
  }
  try {
    const parsed = JSON.parse(toolResult.content) as {
      matches?: Array<{ image_url?: string | null }>;
    };
    if (parsed.matches?.length === 1 && parsed.matches[0]!.image_url) {
      return parsed.matches[0]!.image_url;
    }
    return null;
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
  return { responseText: FALLBACK_ESCALATION_MESSAGE, mediaUrl: null };
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
  customerName?: string,
): Promise<TurnResult> {
  const { conversationId, customerId, state } = await resolveConversation(
    tenantId,
    customerPhone,
    customerName,
  );
  const turnLogger = logger.child({ tenant_id: tenantId, conversation_id: conversationId });

  await appendMessage(tenantId, conversationId, "inbound", "customer", incomingBody);

  if (state.step === "escalado") {
    // El mensaje ya quedó guardado para que el asesor lo vea (vista del
    // asesor, incremento separado) — el agente no responde automáticamente
    // hasta que un humano cierre el caso.
    return { responseText: null, mediaUrl: null };
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
  // Montos reales devueltos por tools — de toda la conversación, no solo
  // de este runTurn. Antes solo se sembraba con las tools llamadas en el
  // turno actual, así que el guardrail escalaba conversaciones válidas
  // cada vez que el agente repetía un precio/subtotal ya confirmado por
  // una tool en un turno anterior (ej. "contame más de X" sobre un
  // producto ya consultado, o mostrar de nuevo el subtotal al aplicar una
  // promoción) — no era una alucinación, solo no era de *este* turno.
  // Sembrar con el historial completo mantiene la garantía real del
  // guardrail (el LLM nunca inventa un monto que ninguna tool devolvió en
  // la conversación) sin escalar por repetir algo ya verificado.
  const knownToolAmounts: number[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_result" && !block.is_error) {
        try {
          knownToolAmounts.push(...extractMonetaryValues(JSON.parse(block.content)));
        } catch {
          // Contenido no-JSON de una tool: nada que extraer, se ignora.
        }
      }
    }
  }
  let guardrailRetries = 0;
  // Última imagen de un match único de consultar_inventario en este
  // runTurn (ver extractSingleMatchImageUrl) — gana la última llamada,
  // igual que montoAltoAmount.
  let mediaUrl: string | null = null;

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
          escalationConfig.montoAltoThreshold,
          toolUse,
        );
        toolResults.push(toolResult);
        if (!toolResult.is_error) {
          knownToolAmounts.push(...extractMonetaryValues(JSON.parse(toolResult.content)));
        }
        const amount = isPedidoRechazadoPorMontoAlto(toolUse.name, toolResult);
        if (amount !== null) {
          montoAltoAmount = amount;
        }
        const singleMatchImageUrl = extractSingleMatchImageUrl(toolUse.name, toolResult);
        if (singleMatchImageUrl !== null) {
          mediaUrl = singleMatchImageUrl;
        }
      }
      messages.push({ role: "user", content: toolResults });
      await appendMessage(tenantId, conversationId, "inbound", "agent", "", toolResults);

      if (montoAltoAmount !== null) {
        return escalateAndReply(
          tenantId,
          conversationId,
          "monto_alto",
          `El pedido ($${montoAltoAmount}) supera el umbral configurado ($${escalationConfig.montoAltoThreshold}) — crear_pedido se negó a confirmarlo.`,
        );
      }

      continue;
    }

    if (response.stopReason === "other") {
      continue;
    }

    const responseText = extractText(response.content);
    const guardrailResult = verifyPriceGuardrail(responseText, knownToolAmounts);
    if (!guardrailResult.ok) {
      await recordAudit(
        tenantId,
        conversationId,
        "orchestrator",
        "guardrail_precio_incidente",
        { responseText, mismatched: guardrailResult.mismatched },
        { knownToolAmounts },
      );
      turnLogger.warn(
        { event: "orchestrator.guardrail_precio_incidente", mismatched: guardrailResult.mismatched },
        "Guardrail de precios detectó un monto no verificable en la respuesta",
      );

      if (guardrailRetries < MAX_GUARDRAIL_RETRIES) {
        guardrailRetries++;
        const retryInstruction: ContentBlock[] = [{ type: "text", text: GUARDRAIL_RETRY_INSTRUCTION }];
        messages.push({ role: "user", content: retryInstruction });
        await appendMessage(tenantId, conversationId, "inbound", "agent", "", retryInstruction);
        continue;
      }

      return escalateAndReply(
        tenantId,
        conversationId,
        "guardrail_precio",
        "El guardrail de verificación de precios detectó un monto en la respuesta que no coincide con ningún resultado real de las tools llamadas en esta conversación.",
      );
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

    await updateState(tenantId, conversationId, {
      step: "resuelto",
      turnos_sin_resolver: turnosSinResolver,
    });
    return { responseText, mediaUrl };
  }

  return escalateAndReply(
    tenantId,
    conversationId,
    "intentos_fallidos",
    "El agente alcanzó el límite de iteraciones de tool calling sin resolver.",
  );
}
