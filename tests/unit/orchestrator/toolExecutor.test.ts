import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/domains/catalog/consultarInventario.js", () => ({
  consultarInventario: vi.fn(),
}));
vi.mock("../../../src/domains/escalation/escalarHumano.js", () => ({
  escalarHumano: vi.fn(),
}));
vi.mock("../../../src/shared/audit/auditLog.js", () => ({
  recordAudit: vi.fn(),
}));

import { consultarInventario } from "../../../src/domains/catalog/consultarInventario.js";
import { escalarHumano } from "../../../src/domains/escalation/escalarHumano.js";
import { recordAudit } from "../../../src/shared/audit/auditLog.js";
import { executeTool } from "../../../src/orchestrator/toolExecutor.js";
import type { ContentBlock } from "../../../src/orchestrator/llm/types.js";

function makeToolUse(name: string, input: unknown): Extract<ContentBlock, { type: "tool_use" }> {
  return { type: "tool_use", id: "toolu_123", name, input };
}

describe("executeTool", () => {
  beforeEach(() => {
    vi.mocked(consultarInventario).mockReset();
    vi.mocked(escalarHumano).mockReset();
    vi.mocked(recordAudit).mockReset();
  });

  it("despacha consultar_inventario al dominio y devuelve el tool_result", async () => {
    vi.mocked(consultarInventario).mockResolvedValue({ matches: [] });

    const result = await executeTool(
      "tenant-1",
      "conv-1",
      makeToolUse("consultar_inventario", { query: "casco" }),
    );

    expect(consultarInventario).toHaveBeenCalledWith("tenant-1", { query: "casco" });
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_123",
      content: JSON.stringify({ matches: [] }),
    });
  });

  it("despacha escalar_a_humano al dominio con tenantId y conversationId", async () => {
    vi.mocked(escalarHumano).mockResolvedValue({
      handoff_id: "h1",
      status: "queued",
      assigned_to: null,
    });

    const result = await executeTool(
      "tenant-1",
      "conv-1",
      makeToolUse("escalar_a_humano", { reason: "queja", summary: "resumen" }),
    );

    expect(escalarHumano).toHaveBeenCalledWith("tenant-1", "conv-1", {
      reason: "queja",
      summary: "resumen",
    });
    expect(result.content).toContain("queued");
  });

  it("devuelve is_error:true si la tool del dominio lanza, sin propagar la excepción", async () => {
    vi.mocked(consultarInventario).mockRejectedValue(new Error("DB caída"));

    const result = await executeTool("tenant-1", "conv-1", makeToolUse("consultar_inventario", {}));

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("DB caída");
  });

  it("registra en audit_log el input propuesto y el output real de la tool", async () => {
    vi.mocked(consultarInventario).mockResolvedValue({ matches: [] });

    await executeTool("tenant-1", "conv-1", makeToolUse("consultar_inventario", { query: "x" }));

    expect(recordAudit).toHaveBeenCalledWith(
      "tenant-1",
      "conv-1",
      "tool",
      "consultar_inventario",
      { query: "x" },
      { matches: [] },
    );
  });
});
