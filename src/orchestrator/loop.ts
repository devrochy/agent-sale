import { escalarHumano } from "../domains/escalation/escalarHumano.js";
import { recordAudit } from "../shared/audit/auditLog.js";
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

export interface TurnResult {
  responseText: string;
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function escalateAndReply(
  tenantId: string,
  conversationId: string,
  reason: "queja" | "intentos_fallidos",
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
  await appendMessage(tenantId, conversationId, "outbound", "agent", FALLBACK_ESCALATION_MESSAGE);
  await updateState(tenantId, conversationId, { step: "escalado" });
  return { responseText: FALLBACK_ESCALATION_MESSAGE };
}

/**
 * Orquesta un turno completo (ver docs/fase-4-motor-agente/orquestador.md):
 * carga memoria, llama a Claude con tool calling manual, ejecuta tools,
 * persiste el resultado. `tenant_id` y `conversation_id` nunca se exponen
 * a Claude como parámetros de tool — los inyecta este módulo.
 */
export async function runTurn(tenantId: string, customerPhone: string, incomingBody: string): Promise<TurnResult> {
  const { conversationId } = await resolveConversation(tenantId, customerPhone);

  await appendMessage(tenantId, conversationId, "inbound", "customer", incomingBody);

  const messages = await loadHistory(tenantId, conversationId);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = await llmProvider.converse({
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      messages,
    });

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
      const toolUseBlocks = response.content.filter(
        (block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use",
      );
      const toolResults: ContentBlock[] = [];
      for (const toolUse of toolUseBlocks) {
        toolResults.push(await executeTool(tenantId, conversationId, toolUse));
      }
      messages.push({ role: "user", content: toolResults });
      await appendMessage(tenantId, conversationId, "inbound", "agent", "", toolResults);
      continue;
    }

    if (response.stopReason === "other") {
      continue;
    }

    // end_turn: responder con el texto final.
    const responseText = extractText(response.content);
    await updateState(tenantId, conversationId, { step: "resuelto" });
    return { responseText };
  }

  return escalateAndReply(
    tenantId,
    conversationId,
    "intentos_fallidos",
    "El agente alcanzó el límite de iteraciones de tool calling sin resolver.",
  );
}
