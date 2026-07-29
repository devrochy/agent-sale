import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/domains/catalog/consultarInventario.js", () => ({
  consultarInventario: vi.fn(),
}));
vi.mock("../../../src/domains/commerce/generarCotizacion.js", () => ({
  generarCotizacion: vi.fn(),
}));
vi.mock("../../../src/domains/commerce/aplicarPromocion.js", () => ({
  aplicarPromocion: vi.fn(),
}));
vi.mock("../../../src/domains/commerce/crearPedido.js", () => ({
  crearPedido: vi.fn(),
}));
vi.mock("../../../src/domains/commerce/recomendarProducto.js", () => ({
  recomendarProducto: vi.fn(),
}));
vi.mock("../../../src/domains/escalation/escalarHumano.js", () => ({
  escalarHumano: vi.fn(),
}));
vi.mock("../../../src/shared/audit/auditLog.js", () => ({
  recordAudit: vi.fn(),
}));

import { consultarInventario } from "../../../src/domains/catalog/consultarInventario.js";
import { aplicarPromocion } from "../../../src/domains/commerce/aplicarPromocion.js";
import { crearPedido } from "../../../src/domains/commerce/crearPedido.js";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import { recomendarProducto } from "../../../src/domains/commerce/recomendarProducto.js";
import { escalarHumano } from "../../../src/domains/escalation/escalarHumano.js";
import { recordAudit } from "../../../src/shared/audit/auditLog.js";
import { executeTool } from "../../../src/orchestrator/toolExecutor.js";
import type { ContentBlock } from "../../../src/orchestrator/llm/types.js";

function makeToolUse(name: string, input: unknown): Extract<ContentBlock, { type: "tool_use" }> {
  return { type: "tool_use", id: "toolu_123", name, input };
}

const run = (name: string, input: unknown) =>
  executeTool("tenant-1", "conv-1", "customer-1", "sid-1", makeToolUse(name, input));

describe("executeTool", () => {
  beforeEach(() => {
    vi.mocked(consultarInventario).mockReset();
    vi.mocked(generarCotizacion).mockReset();
    vi.mocked(aplicarPromocion).mockReset();
    vi.mocked(crearPedido).mockReset();
    vi.mocked(recomendarProducto).mockReset();
    vi.mocked(escalarHumano).mockReset();
    vi.mocked(recordAudit).mockReset();
  });

  it("despacha consultar_inventario al dominio y devuelve el tool_result", async () => {
    vi.mocked(consultarInventario).mockResolvedValue({ matches: [] });

    const result = await run("consultar_inventario", { query: "casco" });

    expect(consultarInventario).toHaveBeenCalledWith("tenant-1", { query: "casco" });
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_123",
      content: JSON.stringify({ matches: [] }),
    });
  });

  it("despacha generar_cotizacion con tenantId, conversationId y customerId", async () => {
    vi.mocked(generarCotizacion).mockResolvedValue({
      quote_id: "q1",
      items: [],
      subtotal: 0,
      status: "draft",
    });

    const items = [{ product_id: "p1", quantity: 2 }];
    await run("generar_cotizacion", { items });

    expect(generarCotizacion).toHaveBeenCalledWith("tenant-1", "conv-1", "customer-1", { items });
  });

  it("despacha aplicar_promocion con tenantId", async () => {
    vi.mocked(aplicarPromocion).mockResolvedValue({
      quote_id: "q1",
      promotion_applied: null,
      subtotal: 100,
      discount: 0,
      total: 100,
    });

    await run("aplicar_promocion", { quote_id: "q1" });

    expect(aplicarPromocion).toHaveBeenCalledWith("tenant-1", { quote_id: "q1" });
  });

  it("despacha crear_pedido con tenantId y el messageSid inyectado, sin exponer idempotency_key al LLM", async () => {
    vi.mocked(crearPedido).mockResolvedValue({ order_id: "o1", status: "confirmed", total: 100 });

    const input = {
      quote_id: "q1",
      payment_method: "transferencia",
      delivery_method: "domicilio",
    };
    await run("crear_pedido", input);

    expect(crearPedido).toHaveBeenCalledWith("tenant-1", "sid-1", input);
  });

  it("despacha recomendar_producto con tenantId", async () => {
    vi.mocked(recomendarProducto).mockResolvedValue({ recommendations: [] });

    await run("recomendar_producto", { product_id: "p1" });

    expect(recomendarProducto).toHaveBeenCalledWith("tenant-1", { product_id: "p1" });
  });

  it("despacha escalar_a_humano al dominio con tenantId y conversationId", async () => {
    vi.mocked(escalarHumano).mockResolvedValue({
      handoff_id: "h1",
      status: "queued",
      assigned_to: null,
    });

    const result = await run("escalar_a_humano", { reason: "queja", summary: "resumen" });

    expect(escalarHumano).toHaveBeenCalledWith("tenant-1", "conv-1", {
      reason: "queja",
      summary: "resumen",
    });
    expect(result.content).toContain("queued");
  });

  it("devuelve is_error:true si la tool del dominio lanza, sin propagar la excepción", async () => {
    vi.mocked(consultarInventario).mockRejectedValue(new Error("DB caída"));

    const result = await run("consultar_inventario", {});

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("DB caída");
  });

  it("registra en audit_log el input propuesto y el output real de la tool", async () => {
    vi.mocked(consultarInventario).mockResolvedValue({ matches: [] });

    await run("consultar_inventario", { query: "x" });

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
