import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/orchestrator/llm/index.js", () => ({
  llmProvider: { converse: vi.fn() },
}));
vi.mock("../../../src/orchestrator/toolExecutor.js", () => ({
  executeTool: vi.fn(),
}));
vi.mock("../../../src/domains/escalation/escalarHumano.js", () => ({
  escalarHumano: vi.fn(),
}));
vi.mock("../../../src/orchestrator/memory.js", () => ({
  resolveConversation: vi.fn(),
  loadHistory: vi.fn(),
  appendMessage: vi.fn(),
  updateState: vi.fn(),
}));
vi.mock("../../../src/shared/db/index.js", () => ({
  getEscalationConfig: vi.fn(),
}));
vi.mock("../../../src/shared/audit/auditLog.js", () => ({
  recordAudit: vi.fn(),
}));

import { escalarHumano } from "../../../src/domains/escalation/escalarHumano.js";
import { llmProvider } from "../../../src/orchestrator/llm/index.js";
import type { TurnResponse } from "../../../src/orchestrator/llm/types.js";
import { runTurn } from "../../../src/orchestrator/loop.js";
import { appendMessage, loadHistory, resolveConversation, updateState } from "../../../src/orchestrator/memory.js";
import { executeTool } from "../../../src/orchestrator/toolExecutor.js";
import { getEscalationConfig } from "../../../src/shared/db/index.js";
import { recordAudit } from "../../../src/shared/audit/auditLog.js";

const USAGE = { inputTokens: 10, outputTokens: 10 };

function endTurn(text: string): TurnResponse {
  return { stopReason: "end_turn", content: [{ type: "text", text }], usage: USAGE };
}

describe("runTurn — guardrail de precios", () => {
  beforeEach(() => {
    vi.mocked(llmProvider.converse).mockReset();
    vi.mocked(executeTool).mockReset();
    vi.mocked(escalarHumano).mockReset();
    vi.mocked(resolveConversation).mockReset();
    vi.mocked(loadHistory).mockReset();
    vi.mocked(appendMessage).mockReset();
    vi.mocked(updateState).mockReset();
    vi.mocked(getEscalationConfig).mockReset();
    vi.mocked(recordAudit).mockReset();

    vi.mocked(resolveConversation).mockResolvedValue({
      conversationId: "conv-1",
      customerId: "customer-1",
      state: {},
    });
    vi.mocked(loadHistory).mockResolvedValue([]);
    vi.mocked(getEscalationConfig).mockResolvedValue(null);
  });

  it("responde normalmente cuando el monto del texto coincide con el resultado real de una tool", async () => {
    vi.mocked(executeTool).mockResolvedValue({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: JSON.stringify({ quote_id: "q1", subtotal: 117000, total: 117000 }),
    });
    vi.mocked(llmProvider.converse)
      .mockResolvedValueOnce({
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "generar_cotizacion", input: {} }],
        usage: USAGE,
      })
      .mockResolvedValueOnce(endTurn("El total de tu cotización es $117.000"));

    const result = await runTurn("tenant-1", "+573000000000", "hola", "sid-1");

    expect(result.responseText).toBe("El total de tu cotización es $117.000");
    expect(llmProvider.converse).toHaveBeenCalledTimes(2);
    expect(escalarHumano).not.toHaveBeenCalled();
  });

  it("reintenta una vez y luego escala por seguridad si el monto del texto no coincide con ninguna tool", async () => {
    vi.mocked(llmProvider.converse).mockResolvedValue(endTurn("El total de tu cotización es $999.000"));
    vi.mocked(escalarHumano).mockResolvedValue({
      handoff_id: "h1",
      status: "queued",
      assigned_to: null,
    });

    const result = await runTurn("tenant-1", "+573000000000", "hola", "sid-1");

    // 1 intento inicial + 1 reintento del guardrail = 2 llamadas al LLM.
    expect(llmProvider.converse).toHaveBeenCalledTimes(2);
    expect(escalarHumano).toHaveBeenCalledWith("tenant-1", "conv-1", {
      reason: "guardrail_precio",
      summary: expect.any(String),
    });
    expect(recordAudit).toHaveBeenCalledWith(
      "tenant-1",
      "conv-1",
      "orchestrator",
      "guardrail_precio_incidente",
      expect.objectContaining({ mismatched: [999000] }),
      expect.anything(),
    );
    // Nunca se devuelve el texto con el monto no verificado.
    expect(result.responseText).not.toContain("999.000");
  });
});
