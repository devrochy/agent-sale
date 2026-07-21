import {
  consultarInventario,
  type ConsultarInventarioInput,
} from "../domains/catalog/consultarInventario.js";
import { escalarHumano, type EscalarHumanoInput } from "../domains/escalation/escalarHumano.js";
import { recordAudit } from "../shared/audit/auditLog.js";
import type { ContentBlock } from "./llm/types.js";

type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;
type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;

/**
 * Ejecuta la tool que el LLM propuso y devuelve el tool_result real (ver
 * docs/fase-4-motor-agente/auditoria.md: el audit_log refleja lo que la
 * tool realmente hizo, no lo que el modelo dijo que iba a hacer).
 */
export async function executeTool(
  tenantId: string,
  conversationId: string,
  toolUse: ToolUseBlock,
): Promise<ToolResultBlock> {
  try {
    let output: unknown;
    switch (toolUse.name) {
      case "consultar_inventario":
        output = await consultarInventario(tenantId, toolUse.input as ConsultarInventarioInput);
        break;
      case "escalar_a_humano":
        output = await escalarHumano(
          tenantId,
          conversationId,
          toolUse.input as EscalarHumanoInput,
        );
        break;
      default:
        throw new Error(`Tool desconocida: ${toolUse.name}`);
    }

    await recordAudit(tenantId, conversationId, "tool", toolUse.name, toolUse.input, output);

    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: JSON.stringify(output),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordAudit(tenantId, conversationId, "tool", toolUse.name, toolUse.input, {
      error: message,
    });
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: message,
      is_error: true,
    };
  }
}
