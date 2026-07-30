import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/orchestrator/llm/index.js", () => ({
  resolveLlmProviderForTenant: vi.fn(),
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
  updateMessageContent: vi.fn(),
  updateState: vi.fn(),
}));
vi.mock("../../../src/shared/db/index.js", () => ({
  getBehaviorConfig: vi.fn(),
  getEscalationConfig: vi.fn(),
}));
vi.mock("../../../src/shared/audit/auditLog.js", () => ({
  recordAudit: vi.fn(),
}));

import { escalarHumano } from "../../../src/domains/escalation/escalarHumano.js";
import { resolveLlmProviderForTenant } from "../../../src/orchestrator/llm/index.js";
import type { TurnResponse } from "../../../src/orchestrator/llm/types.js";
import { runTurn } from "../../../src/orchestrator/loop.js";
import {
  appendMessage,
  loadHistory,
  resolveConversation,
  updateMessageContent,
  updateState,
} from "../../../src/orchestrator/memory.js";
import { executeTool } from "../../../src/orchestrator/toolExecutor.js";
import { getBehaviorConfig, getEscalationConfig } from "../../../src/shared/db/index.js";
import { recordAudit } from "../../../src/shared/audit/auditLog.js";

const USAGE = { inputTokens: 10, outputTokens: 10 };

// Simula la resolución del proveedor de LLM por tenant (Fase 11.4, ver
// ADR-020) — todos los tests siguen mockeando "la llamada al LLM" a
// través de este único `converse` compartido, igual que antes mockeaban
// `llmProvider.converse` directo.
const mockConverse = vi.fn();

function endTurn(text: string): TurnResponse {
  return { stopReason: "end_turn", content: [{ type: "text", text }], usage: USAGE };
}

describe("runTurn — guardrail de precios", () => {
  beforeEach(() => {
    mockConverse.mockReset();
    vi.mocked(resolveLlmProviderForTenant).mockReset();
    vi.mocked(executeTool).mockReset();
    vi.mocked(escalarHumano).mockReset();
    vi.mocked(resolveConversation).mockReset();
    vi.mocked(loadHistory).mockReset();
    vi.mocked(appendMessage).mockReset();
    vi.mocked(updateState).mockReset();
    vi.mocked(getEscalationConfig).mockReset();
    vi.mocked(getBehaviorConfig).mockReset();
    vi.mocked(recordAudit).mockReset();

    vi.mocked(resolveLlmProviderForTenant).mockResolvedValue({
      provider: { converse: mockConverse },
      model: "test-model",
      providerKey: "env-default",
    });
    vi.mocked(resolveConversation).mockResolvedValue({
      conversationId: "conv-1",
      customerId: "customer-1",
      state: {},
    });
    vi.mocked(loadHistory).mockResolvedValue([]);
    vi.mocked(getEscalationConfig).mockResolvedValue(null);
    vi.mocked(getBehaviorConfig).mockResolvedValue(null);
  });

  it("responde normalmente cuando el monto del texto coincide con el resultado real de una tool", async () => {
    vi.mocked(executeTool).mockResolvedValue({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: JSON.stringify({ quote_id: "q1", subtotal: 117000, total: 117000 }),
    });
    mockConverse
      .mockResolvedValueOnce({
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "generar_cotizacion", input: {} }],
        usage: USAGE,
      })
      .mockResolvedValueOnce(endTurn("El total de tu cotización es $117.000"));

    const result = await runTurn("tenant-1", "+573000000000", "hola", "sid-1");

    expect(result.responseText).toBe("El total de tu cotización es $117.000");
    expect(mockConverse).toHaveBeenCalledTimes(2);
    expect(escalarHumano).not.toHaveBeenCalled();
  });

  it("reintenta una vez y luego escala por seguridad si el monto del texto no coincide con ninguna tool", async () => {
    mockConverse.mockResolvedValue(endTurn("El total de tu cotización es $999.000"));
    vi.mocked(escalarHumano).mockResolvedValue({
      handoff_id: "h1",
      status: "queued",
      assigned_to: null,
    });

    const result = await runTurn("tenant-1", "+573000000000", "hola", "sid-1");

    // 1 intento inicial + 1 reintento del guardrail = 2 llamadas al LLM.
    expect(mockConverse).toHaveBeenCalledTimes(2);
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
    mockConverse.mockResolvedValue(endTurn("Los guantes de cuero touring están en $95.000 cada par."));

    const result = await runTurn("tenant-1", "+573000000000", "y esos guantes?", "sid-2");

    expect(result.responseText).toBe("Los guantes de cuero touring están en $95.000 cada par.");
    expect(escalarHumano).not.toHaveBeenCalled();
  });
});

describe("runTurn — guardrail de stock (Fase 12.1)", () => {
  beforeEach(() => {
    mockConverse.mockReset();
    vi.mocked(resolveLlmProviderForTenant).mockReset();
    vi.mocked(executeTool).mockReset();
    vi.mocked(escalarHumano).mockReset();
    vi.mocked(resolveConversation).mockReset();
    vi.mocked(loadHistory).mockReset();
    vi.mocked(appendMessage).mockReset();
    vi.mocked(updateState).mockReset();
    vi.mocked(getEscalationConfig).mockReset();
    vi.mocked(getBehaviorConfig).mockReset();
    vi.mocked(recordAudit).mockReset();

    vi.mocked(resolveLlmProviderForTenant).mockResolvedValue({
      provider: { converse: mockConverse },
      model: "test-model",
      providerKey: "env-default",
    });
    vi.mocked(resolveConversation).mockResolvedValue({
      conversationId: "conv-1",
      customerId: "customer-1",
      state: {},
    });
    vi.mocked(loadHistory).mockResolvedValue([]);
    vi.mocked(getEscalationConfig).mockResolvedValue(null);
    vi.mocked(getBehaviorConfig).mockResolvedValue(null);
  });

  it("responde normalmente cuando la cantidad de stock del texto coincide con el resultado real de una tool", async () => {
    vi.mocked(executeTool).mockResolvedValue({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: JSON.stringify({ matches: [{ sku: "CAS-001", price: 300000, stock: 12 }] }),
    });
    mockConverse
      .mockResolvedValueOnce({
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "consultar_inventario", input: {} }],
        usage: USAGE,
      })
      .mockResolvedValueOnce(endTurn("El casco cuesta $300.000. Quedan 12."));

    const result = await runTurn("tenant-1", "+573000000000", "tienen cascos?", "sid-5");

    expect(result.responseText).toBe("El casco cuesta $300.000. Quedan 12.");
    expect(escalarHumano).not.toHaveBeenCalled();
  });

  it("reintenta una vez y luego escala por seguridad si la cantidad de stock del texto no coincide con ninguna tool", async () => {
    vi.mocked(executeTool).mockResolvedValue({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: JSON.stringify({ matches: [{ sku: "CAS-001", price: 300000, stock: 12 }] }),
    });
    mockConverse
      .mockResolvedValueOnce({
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "consultar_inventario", input: {} }],
        usage: USAGE,
      })
      .mockResolvedValue(endTurn("El casco cuesta $300.000. Quedan 99."));
    vi.mocked(escalarHumano).mockResolvedValue({
      handoff_id: "h1",
      status: "queued",
      assigned_to: null,
    });

    const result = await runTurn("tenant-1", "+573000000000", "tienen cascos?", "sid-6");

    // 1 tool_use + 1 intento inicial + 1 reintento del guardrail = 3 llamadas al LLM.
    expect(mockConverse).toHaveBeenCalledTimes(3);
    expect(escalarHumano).toHaveBeenCalledWith("tenant-1", "conv-1", {
      reason: "guardrail_stock",
      summary: expect.any(String),
    });
    expect(recordAudit).toHaveBeenCalledWith(
      "tenant-1",
      "conv-1",
      "orchestrator",
      "guardrail_stock_incidente",
      expect.objectContaining({ mismatched: [99] }),
      expect.anything(),
    );
    expect(result.responseText).not.toContain("99");
  });
});

describe("runTurn — regla de monto alto", () => {
  beforeEach(() => {
    mockConverse.mockReset();
    vi.mocked(resolveLlmProviderForTenant).mockReset();
    vi.mocked(executeTool).mockReset();
    vi.mocked(escalarHumano).mockReset();
    vi.mocked(resolveConversation).mockReset();
    vi.mocked(loadHistory).mockReset();
    vi.mocked(appendMessage).mockReset();
    vi.mocked(updateState).mockReset();
    vi.mocked(getEscalationConfig).mockReset();
    vi.mocked(getBehaviorConfig).mockReset();
    vi.mocked(recordAudit).mockReset();

    vi.mocked(resolveLlmProviderForTenant).mockResolvedValue({
      provider: { converse: mockConverse },
      model: "test-model",
      providerKey: "env-default",
    });
    vi.mocked(resolveConversation).mockResolvedValue({
      conversationId: "conv-1",
      customerId: "customer-1",
      state: {},
    });
    vi.mocked(loadHistory).mockResolvedValue([]);
    vi.mocked(getEscalationConfig).mockResolvedValue(null);
    vi.mocked(getBehaviorConfig).mockResolvedValue(null);
  });

  it("no escala en generar_cotizacion aunque el subtotal supere el umbral (todavía no es el monto final, puede bajar con una promoción)", async () => {
    vi.mocked(executeTool).mockResolvedValue({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: JSON.stringify({ quote_id: "q1", subtotal: 1500000, total: 1500000 }),
    });
    mockConverse
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
    mockConverse.mockResolvedValueOnce({
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

describe("runTurn — link de pago (Fase 12.4, Wompi)", () => {
  beforeEach(() => {
    mockConverse.mockReset();
    vi.mocked(resolveLlmProviderForTenant).mockReset();
    vi.mocked(executeTool).mockReset();
    vi.mocked(escalarHumano).mockReset();
    vi.mocked(resolveConversation).mockReset();
    vi.mocked(loadHistory).mockReset();
    vi.mocked(appendMessage).mockReset();
    vi.mocked(updateMessageContent).mockReset();
    vi.mocked(updateState).mockReset();
    vi.mocked(getEscalationConfig).mockReset();
    vi.mocked(getBehaviorConfig).mockReset();
    vi.mocked(recordAudit).mockReset();

    vi.mocked(resolveLlmProviderForTenant).mockResolvedValue({
      provider: { converse: mockConverse },
      model: "test-model",
      providerKey: "env-default",
    });
    vi.mocked(resolveConversation).mockResolvedValue({
      conversationId: "conv-1",
      customerId: "customer-1",
      state: {},
    });
    vi.mocked(loadHistory).mockResolvedValue([]);
    vi.mocked(getEscalationConfig).mockResolvedValue(null);
    vi.mocked(getBehaviorConfig).mockResolvedValue(null);
    // El id que appendMessage devuelve para el mensaje del agente — usado
    // para corregir `content` con el link ya al final del turno (ver
    // updateMessageContent en memory.ts).
    vi.mocked(appendMessage).mockResolvedValue("msg-agent-1");
  });

  it("anexa el payment_link_url de crear_pedido al final de la respuesta, de forma determinística", async () => {
    vi.mocked(executeTool).mockResolvedValue({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: JSON.stringify({
        order_id: "order-1",
        status: "confirmed",
        total: 100000,
        payment_link_url: "https://checkout.wompi.co/l/abc123",
      }),
    });
    mockConverse
      .mockResolvedValueOnce({
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "crear_pedido", input: {} }],
        usage: USAGE,
      })
      .mockResolvedValueOnce(
        endTurn("Perfecto, tu pedido queda pendiente hasta que pagues el link."),
      );

    const result = await runTurn("tenant-1", "+573000000000", "pago en línea por favor", "sid-5");

    const expectedText =
      "Perfecto, tu pedido queda pendiente hasta que pagues el link.\n\nhttps://checkout.wompi.co/l/abc123";
    expect(result.responseText).toBe(expectedText);
    // La transcripción persistida se corrige para coincidir con lo que
    // realmente se manda por WhatsApp — ver updateMessageContent.
    expect(updateMessageContent).toHaveBeenCalledWith("tenant-1", "msg-agent-1", expectedText);
  });

  it("no agrega nada al texto si crear_pedido no devuelve payment_link_url (métodos de pago existentes)", async () => {
    vi.mocked(executeTool).mockResolvedValue({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: JSON.stringify({ order_id: "order-2", status: "confirmed", total: 50000 }),
    });
    mockConverse
      .mockResolvedValueOnce({
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "crear_pedido", input: {} }],
        usage: USAGE,
      })
      .mockResolvedValueOnce(endTurn("Tu pedido quedó confirmado."));

    const result = await runTurn("tenant-1", "+573000000000", "pago con transferencia", "sid-6");

    expect(result.responseText).toBe("Tu pedido quedó confirmado.");
    expect(updateMessageContent).not.toHaveBeenCalled();
  });
});
