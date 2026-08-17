import type { EscalationReason } from "../domains/escalation/escalarHumano.js";
import { escalarHumano } from "../domains/escalation/escalarHumano.js";
import { recordAudit } from "../shared/audit/auditLog.js";
import { getBehaviorConfig, getBrandVoiceConfig, getEscalationConfig } from "../shared/db/index.js";
import { withTransaction } from "../shared/db/withTransaction.js";
import { logger } from "../shared/observability/logger.js";
import {
  extractMonetaryValues,
  extractStockValues,
  verifyPriceGuardrail,
  verifyStockGuardrail,
} from "../shared/observability/priceGuardrail.js";
import { calculateCost } from "../shared/pricing.js";
import { resolveBehaviorConfig } from "./behaviorConfig.js";
import { buildBrandVoiceBlock, resolveBrandVoiceConfig } from "./brandVoiceBlock.js";
import { matchKeywordEscalation, resolveEscalationConfig } from "./escalationRules.js";
import type { DifficultySignal } from "./llm/difficultyRouting.js";
import { resolveLlmProvider, type ContentBlock, type LLMMessage } from "./llm/index.js";
import {
  appendMessage,
  loadHistory,
  resolveConversation,
  updateMessageContent,
  updateState,
  type InboundOrigin,
} from "./memory.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { TOOL_DEFINITIONS } from "./toolDefinitions.js";
import { executeTool } from "./toolExecutor.js";
import { TONE_BLOCKS } from "./toneBlocks.js";

// Límite de iteraciones del loop (ver docs/fase-4-motor-agente/orquestador.md):
// evita que un error de razonamiento deje al agente llamando tools indefinidamente.
const MAX_ITERATIONS = 6;

const FALLBACK_ESCALATION_MESSAGE =
  "En este momento no puedo continuar por acá — ya avisé a un asesor de ForMotos para que te contacte en breve.";

// Guardrail de precios (ver docs/fase-8-observabilidad-seguridad/guardrails.md,
// "Guardrail 1"): un solo reintento de generación antes de escalar por
// seguridad — nunca se envía al cliente un monto que no se pudo verificar.
const MAX_GUARDRAIL_RETRIES = 1;
const GUARDRAIL_RETRY_INSTRUCTION_PRECIO =
  "Tu respuesta anterior incluye un monto en pesos que no coincide con ningún resultado real de las tools llamadas en esta conversación. Genera una respuesta nueva usando únicamente montos que sí devolvió alguna tool.";
// Extensión de "Guardrail 1" a disponibilidad (Fase 12.1, ver
// analisis-superpoderes.md, superpoder #1) — misma técnica y mismo
// presupuesto de reintento que el guardrail de precios.
const GUARDRAIL_RETRY_INSTRUCTION_STOCK =
  'Tu respuesta anterior incluye una cantidad de stock ("Quedan N") que no coincide con ningún resultado real de consultar_inventario en esta conversación. Genera una respuesta nueva usando únicamente la cantidad de stock que sí devolvió la tool.';

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
 * Señal de dificultad para "Cerebro del bot" (ADR-023): junta el texto de
 * los mensajes de cliente en texto plano desde el final del historial
 * hacia atrás, hasta el primero que no sea un mensaje de texto simple del
 * cliente (un turno del agente, o un `tool_result` — que también es
 * `role: "user"` pero con contenido en array, no string). Bajo debounce
 * (ADR-022) esto puede juntar más de un mensaje del cliente en un mismo
 * turno; sin debounce, es simplemente el último mensaje.
 */
function buildDifficultySignal(messages: LLMMessage[], state: Record<string, unknown>): DifficultySignal {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user" || typeof message.content !== "string") {
      break;
    }
    texts.unshift(message.content);
  }
  return {
    latestCustomerText: texts.join(" "),
    turnosSinResolver: typeof state.turnos_sin_resolver === "number" ? state.turnos_sin_resolver : 0,
  };
}

/**
 * "monto_alto" de crear_pedido/agregar_item_pedido significa que la tool
 * se negó a confirmar el pedido o el lote de items (ver crearPedido.ts/
 * agregarItemPedido.ts: el chequeo corre *antes* del INSERT, así que si
 * devuelve esto no se creó ni se modificó nada, ni se descontó stock —
 * evita el problema de escalar después de haber confirmado ya el pedido).
 */
function isPedidoRechazadoPorMontoAlto(toolName: string, toolResult: ContentBlock): number | null {
  if (
    (toolName !== "crear_pedido" && toolName !== "agregar_item_pedido") ||
    toolResult.type !== "tool_result" ||
    toolResult.is_error
  ) {
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

/**
 * Link de pago de Wompi a anexar a la respuesta (Fase 12.4, ver ADR-024):
 * mismo criterio determinístico que extractSingleMatchImageUrl —
 * "crear_pedido" y "agregar_item_pedido" pueden devolver "payment_link_url"
 * cuando el método es 'pago_en_linea' y el pedido queda (o sigue) pendiente
 * de pago con un total actualizado; nunca se confía en que el modelo copie
 * el link correctamente en su texto.
 */
function extractPaymentLinkUrl(toolName: string, toolResult: ContentBlock): string | null {
  if (
    (toolName !== "crear_pedido" && toolName !== "agregar_item_pedido") ||
    toolResult.type !== "tool_result" ||
    toolResult.is_error
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(toolResult.content) as { payment_link_url?: string };
    return parsed.payment_link_url ?? null;
  } catch {
    return null;
  }
}

async function escalateAndReply(
  conversationId: string,
  reason: EscalationReason,
  summary: string,
): Promise<TurnResult> {
  const escalation = await escalarHumano(conversationId, { reason, summary });
  await recordAudit(conversationId, "orchestrator", "escalar_a_humano", { reason, summary }, escalation);
  logger
    .child({ conversation_id: conversationId })
    .info({ event: "orchestrator.escalado", reason }, "Conversación escalada a un asesor humano");
  await appendMessage(conversationId, "outbound", "agent", FALLBACK_ESCALATION_MESSAGE);
  await updateState(conversationId, { step: "escalado" });
  return { responseText: FALLBACK_ESCALATION_MESSAGE, mediaUrl: null };
}

/**
 * Ingesta de un mensaje entrante (Fase 11.4 extendida — Velocidad de
 * respuesta, ver ADR-022): se llama SIEMPRE, de inmediato, por cada
 * mensaje que llega — nunca se difiere, ni siquiera con debounce activo.
 * Guarda el mensaje y corre las dos únicas reglas que no pueden esperar a
 * que venza la ventana de debounce: el estado ya escalado (no hay nada
 * más que hacer) y el backstop de palabras clave (si un mensaje
 * intermedio dentro de la ventana matchea una keyword, tiene que escalar
 * ya — esperar al último mensaje de la ventana podría taparlo). Devuelve
 * `conversationId` porque el caller lo necesita para programar/cancelar
 * el timer de debounce, aunque `processConversation` lo vuelva a
 * resolver — es más simple reusar `resolveConversation` (idempotente)
 * que empezar a pasar el objeto de conversación entre funciones.
 */
export async function appendInbound(
  customerPhone: string,
  incomingBody: string,
  customerName?: string,
  origin?: InboundOrigin,
): Promise<{ conversationId: string; escalatedNow: TurnResult | null }> {
  const { conversationId, state } = await resolveConversation(customerPhone, customerName, origin);
  await appendMessage(conversationId, "inbound", "customer", incomingBody);

  if (state.step === "escalado") {
    // El mensaje ya quedó guardado para que el asesor lo vea (vista del
    // asesor, incremento separado) — el agente no responde automáticamente
    // hasta que un humano cierre el caso.
    return { conversationId, escalatedNow: { responseText: null, mediaUrl: null } };
  }

  const escalationConfig = resolveEscalationConfig(await getEscalationConfig());
  const keywordMatch = matchKeywordEscalation(incomingBody, escalationConfig);
  if (keywordMatch) {
    const result = await escalateAndReply(
      conversationId,
      keywordMatch.reason,
      `El mensaje del cliente contiene el término "${keywordMatch.matchedTerm}" (regla de palabras clave).`,
    );
    return { conversationId, escalatedNow: result };
  }

  return { conversationId, escalatedNow: null };
}

/**
 * Resto del turno (ver docs/fase-4-motor-agente/orquestador.md y
 * docs/fase-7-escalamiento-humano/reglas-escalamiento.md): carga
 * memoria, llama al proveedor de LLM con tool calling manual, ejecuta
 * tools, persiste el resultado. Arranca desde `resolveConversation` de
 * nuevo (no desde el mensaje puntual que disparó el turno) para que, si
 * `appendInbound` se llamó varias veces durante una ventana de debounce
 * (ver ADR-022), este turno vea el estado y el historial más recientes —
 * incluye todos los mensajes acumulados, no solo el último. `conversation_id`
 * y `customer_id` nunca se exponen al LLM como parámetros de tool — los
 * inyecta este módulo. `messageSid` se usa solo para el idempotency_key
 * de crear_pedido (ver domains/commerce/crearPedido.ts) — con debounce,
 * es el Sid del último mensaje que (re)armó el timer.
 */
export async function processConversation(
  customerPhone: string,
  messageSid: string,
  customerName?: string,
  origin?: InboundOrigin,
): Promise<TurnResult> {
  const { conversationId, customerId, state } = await resolveConversation(
    customerPhone,
    customerName,
    origin,
  );
  const turnLogger = logger.child({ conversation_id: conversationId });

  if (state.step === "escalado") {
    return { responseText: null, mediaUrl: null };
  }

  const escalationConfig = resolveEscalationConfig(await getEscalationConfig());
  // Tono de voz del negocio (Fase 11.4 extendida, ver ADR-021) — segundo
  // bloque de `system`, con su propio cache_control en AnthropicProvider.
  const behaviorConfig = resolveBehaviorConfig(await getBehaviorConfig());
  // Voz de marca + RAG institucional (Fase 20, ver ADR-030) — tercer
  // bloque, solo se agrega (y solo entonces se paga un breakpoint más)
  // cuando el negocio configuró algo.
  const brandVoiceConfig = resolveBrandVoiceConfig(await getBrandVoiceConfig());
  const brandVoiceBlock = buildBrandVoiceBlock(brandVoiceConfig);
  const systemPrompt = [SYSTEM_PROMPT, TONE_BLOCKS[behaviorConfig.tono]];
  if (brandVoiceBlock) {
    systemPrompt.push(brandVoiceBlock);
  }

  const messages = await loadHistory(conversationId);
  // Se resuelve una sola vez por turno (Fase 11.4, ver ADR-020) — un turno
  // puede llamar al LLM varias veces (tool calling), todas usan el mismo
  // proveedor/modelo, nunca se re-resuelve a mitad de turno. `model`/
  // `providerKey` quedan disponibles para el insert de llm_usage (Fase
  // 11.5). `difficultySignal` solo importa si "Cerebro del bot" está
  // activo (ADR-023) — se arma desde el historial recién cargado, no
  // desde un `incomingBody` puntual (bajo debounce, ver ADR-022, puede
  // haber más de un mensaje de cliente en este turno).
  const difficultySignal = buildDifficultySignal(messages, state);
  const {
    provider: llmProvider,
    model: resolvedModel,
    providerKey,
    dificultad,
  } = await resolveLlmProvider(difficultySignal);

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
  // Mismo criterio que knownToolAmounts, para el guardrail de stock
  // (ver priceGuardrail.ts, verifyStockGuardrail): cantidades reales de
  // "stock" devueltas por consultar_inventario en toda la conversación.
  const knownStockAmounts: number[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_result" && !block.is_error) {
        try {
          const parsed = JSON.parse(block.content);
          knownToolAmounts.push(...extractMonetaryValues(parsed));
          knownStockAmounts.push(...extractStockValues(parsed));
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
  // Link de pago de Wompi de este runTurn (ver extractPaymentLinkUrl) —
  // mismo criterio que mediaUrl, gana la última llamada.
  let paymentLinkUrl: string | null = null;
  // Id del último mensaje de agente persistido (ver appendMessage más
  // abajo) — necesario para corregir su `content` con el link de pago
  // ya al final del turno, ver updateMessageContent.
  let lastAssistantMessageId: string | null = null;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    turnLogger.info(
      { event: "orchestrator.llm_iniciado", iteration, model: resolvedModel, dificultad },
      "Llamada al LLM iniciada",
    );
    const llmStartedAt = Date.now();
    const response = await llmProvider.converse({
      systemPrompt,
      tools: TOOL_DEFINITIONS,
      messages,
    });
    const llmLatencyMs = Date.now() - llmStartedAt;
    turnLogger.info(
      {
        event: "orchestrator.llm_completado",
        iteration,
        model: resolvedModel,
        dificultad,
        latency_ms: llmLatencyMs,
        stop_reason: response.stopReason,
        usage: response.usage,
      },
      "Llamada al LLM completada",
    );

    await recordAudit(conversationId, "agent", "turno_conversacion", null, {
      stop_reason: response.stopReason,
      usage: response.usage,
    });

    // Espejo de negocio en Postgres (Fase 11.5, ver ADR-017 y
    // analitica-costos.md) — best-effort: un fallo acá no debe interrumpir
    // la respuesta al cliente, el log a Loki sigue siendo la fuente de
    // verdad operacional.
    try {
      const cost = calculateCost(resolvedModel, response.usage.inputTokens, response.usage.outputTokens);
      await withTransaction((client) =>
        client.query(
          `INSERT INTO llm_usage
             (conversation_id, provider, model, input_tokens, output_tokens, latency_ms, cost_usd)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            conversationId,
            providerKey,
            resolvedModel,
            response.usage.inputTokens,
            response.usage.outputTokens,
            llmLatencyMs,
            cost,
          ],
        ),
      );
    } catch (error) {
      turnLogger.warn({ error, event: "orchestrator.llm_usage_insert_fallido" }, "No se pudo registrar el uso de LLM en llm_usage");
    }

    if (response.stopReason === "refusal") {
      await recordAudit(conversationId, "orchestrator", "refusal", null, {
        category: response.refusalCategory ?? null,
      });
      return escalateAndReply(
        conversationId,
        "queja",
        "El agente rehusó continuar la conversación (stop_reason: refusal).",
      );
    }

    messages.push({ role: "assistant", content: response.content });
    lastAssistantMessageId = await appendMessage(
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
          conversationId,
          customerId,
          messageSid,
          escalationConfig.montoAltoThreshold,
          toolUse,
        );
        toolResults.push(toolResult);
        if (!toolResult.is_error) {
          const parsedResult = JSON.parse(toolResult.content);
          knownToolAmounts.push(...extractMonetaryValues(parsedResult));
          knownStockAmounts.push(...extractStockValues(parsedResult));
        }
        const amount = isPedidoRechazadoPorMontoAlto(toolUse.name, toolResult);
        if (amount !== null) {
          montoAltoAmount = amount;
        }
        const singleMatchImageUrl = extractSingleMatchImageUrl(toolUse.name, toolResult);
        if (singleMatchImageUrl !== null) {
          mediaUrl = singleMatchImageUrl;
        }
        const linkPago = extractPaymentLinkUrl(toolUse.name, toolResult);
        if (linkPago !== null) {
          paymentLinkUrl = linkPago;
        }
      }
      messages.push({ role: "user", content: toolResults });
      await appendMessage(conversationId, "inbound", "agent", "", toolResults);

      if (montoAltoAmount !== null) {
        return escalateAndReply(
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
    const priceGuardrailResult = verifyPriceGuardrail(responseText, knownToolAmounts);
    // Extensión de "Guardrail 1" a disponibilidad (Fase 12.1) — mismo
    // presupuesto de reintento que precio; si ambos fallan a la vez se
    // prioriza reportar/escalar precio (mayor riesgo de negocio, ver
    // guardrails.md), el stock inventado quedaría cubierto por el mismo
    // reintento igual.
    const stockGuardrailResult = priceGuardrailResult.ok
      ? verifyStockGuardrail(responseText, knownStockAmounts)
      : { ok: true, mismatched: [] as number[] };
    if (!priceGuardrailResult.ok || !stockGuardrailResult.ok) {
      const failedGuardrail: "precio" | "stock" = !priceGuardrailResult.ok ? "precio" : "stock";
      await recordAudit(
        conversationId,
        "orchestrator",
        failedGuardrail === "precio" ? "guardrail_precio_incidente" : "guardrail_stock_incidente",
        {
          responseText,
          mismatched: failedGuardrail === "precio" ? priceGuardrailResult.mismatched : stockGuardrailResult.mismatched,
        },
        { knownToolAmounts, knownStockAmounts },
      );
      turnLogger.warn(
        {
          event:
            failedGuardrail === "precio"
              ? "orchestrator.guardrail_precio_incidente"
              : "orchestrator.guardrail_stock_incidente",
          mismatched: failedGuardrail === "precio" ? priceGuardrailResult.mismatched : stockGuardrailResult.mismatched,
        },
        `Guardrail de ${failedGuardrail} detectó un valor no verificable en la respuesta`,
      );

      if (guardrailRetries < MAX_GUARDRAIL_RETRIES) {
        guardrailRetries++;
        const retryText =
          failedGuardrail === "precio" ? GUARDRAIL_RETRY_INSTRUCTION_PRECIO : GUARDRAIL_RETRY_INSTRUCTION_STOCK;
        const retryInstruction: ContentBlock[] = [{ type: "text", text: retryText }];
        messages.push({ role: "user", content: retryInstruction });
        await appendMessage(conversationId, "inbound", "agent", "", retryInstruction);
        continue;
      }

      return escalateAndReply(
        conversationId,
        failedGuardrail === "precio" ? "guardrail_precio" : "guardrail_stock",
        failedGuardrail === "precio"
          ? "El guardrail de verificación de precios detectó un monto en la respuesta que no coincide con ningún resultado real de las tools llamadas en esta conversación."
          : "El guardrail de verificación de stock detectó una cantidad en la respuesta que no coincide con ningún resultado real de consultar_inventario en esta conversación.",
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
        conversationId,
        "intentos_fallidos",
        `El agente respondió ${turnosSinResolver} turnos consecutivos sin usar ninguna tool para resolver la necesidad del cliente.`,
      );
    }

    await updateState(conversationId, {
      step: "resuelto",
      turnos_sin_resolver: turnosSinResolver,
    });
    // El link de pago se anexa acá, después de los guardrails de
    // precio/stock (para no dispararlos con la URL) y antes del split de
    // burbujas de messageSplitter.ts — así queda como su propio mensaje de
    // WhatsApp, nunca dependiendo de que el modelo lo haya copiado bien.
    const finalResponseText = paymentLinkUrl
      ? `${responseText}\n\n${paymentLinkUrl}`
      : responseText;
    if (paymentLinkUrl && lastAssistantMessageId) {
      // El appendMessage original (más arriba) persistió el texto crudo
      // del LLM, sin el link — se corrige acá para que la transcripción
      // del panel/vista del asesor coincida con lo que el cliente recibió
      // de verdad por WhatsApp.
      await updateMessageContent(lastAssistantMessageId, finalResponseText);
    }
    return { responseText: finalResponseText, mediaUrl };
  }

  return escalateAndReply(
    conversationId,
    "intentos_fallidos",
    "El agente alcanzó el límite de iteraciones de tool calling sin resolver.",
  );
}

/**
 * Conveniencia para el caso "inmediato" (default — ver ADR-022): ingesta
 * y procesamiento en la misma llamada, sin pasar por la cola de
 * debounce. Firma y comportamiento idénticos a los del `runTurn` de
 * antes de esta fase — cero regresión sin `behavior_config` configurado.
 * Con debounce activo, `consumer.ts` llama `appendInbound` y
 * `processConversation` por separado (ver debounceScheduler.ts).
 */
export async function runTurn(
  customerPhone: string,
  incomingBody: string,
  messageSid: string,
  customerName?: string,
): Promise<TurnResult> {
  const { escalatedNow } = await appendInbound(customerPhone, incomingBody, customerName);
  if (escalatedNow) {
    return escalatedNow;
  }
  return processConversation(customerPhone, messageSid, customerName);
}
