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

  it("no escala si el monto ya fue confirmado por una tool en un turno anterior de la misma conversación", async () => {
    // Historial con un tool_result de un turno previo (ej. consultar_inventario)
    // que ya devolvió $95.000 — el guardrail debe reconocerlo aunque este
    // turno no vuelva a llamar ninguna tool.
    vi.mocked(loadHistory).mockResolvedValue([
      { role: "user", content: "tienen guantes de cuero?" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_prev", name: "consultar_inventario", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_prev",
            content: JSON.stringify({ matches: [{ sku: "GUA-001", price: 95000 }] }),
          },
        ],
      },
    ]);
    vi.mocked(llmProvider.converse).mockResolvedValue(
      endTurn("Los guantes de cuero touring están en $95.000 cada par."),
    );

    const result = await runTurn("tenant-1", "+573000000000", "y esos guantes?", "sid-2");

    expect(result.responseText).toBe("Los guantes de cuero touring están en $95.000 cada par.");
    expect(escalarHumano).not.toHaveBeenCalled();
  });
});

describe("runTurn — regla de monto alto", () => {
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

  it("no escala en generar_cotizacion aunque el subtotal supere el umbral (todavía no es el monto final, puede bajar con una promoción)", async () => {
    vi.mocked(executeTool).mockResolvedValue({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: JSON.stringify({ quote_id: "q1", subtotal: 1500000, total: 1500000 }),
    });
    vi.mocked(llmProvider.converse)
      .mockResolvedValueOnce({
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "generar_cotizacion", input: {} }],
        usage: USAGE,
      })
      .mockResolvedValueOnce(endTurn("Tu cotización es de $1.500.000. ¿Vemos si aplica alguna promo?"));

    const result = await runTurn("tenant-1", "+573000000000", "cotiza 2 cascos", "sid-3");

    expect(result.responseText).toContain("1.500.000");
    expect(escalarHumano).not.toHaveBeenCalled();
  });

  it("escala si crear_pedido se niega a confirmar por monto alto (no crea el pedido, solo entonces escala)", async () => {
    vi.mocked(executeTool).mockResolvedValue({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: JSON.stringify({ order_id: null, status: "monto_alto", total: 1500000 }),
    });
    vi.mocked(llmProvider.converse).mockResolvedValueOnce({
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: "toolu_1", name: "crear_pedido", input: {} }],
      usage: USAGE,
    });
    vi.mocked(escalarHumano).mockResolvedValue({
      handoff_id: "h1",
      status: "queued",
      assigned_to: null,
    });

    await runTurn("tenant-1", "+573000000000", "confirmo el pedido", "sid-4");

    expect(escalarHumano).toHaveBeenCalledWith("tenant-1", "conv-1", {
      reason: "monto_alto",
      summary: expect.any(String),
    });
  });
});
