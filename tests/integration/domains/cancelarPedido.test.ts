import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendToConversation: vi.fn(),
  getWhatsAppMessageStatus: vi.fn(),
}));

import { sendWhatsAppMessage, sendToConversation } from "../../../src/gateway/sendMessage.js";
import { createAdmin, updateAdminPermissions } from "../../../src/admin/auth/adminsDirectory.js";
import { hashPassword } from "../../../src/admin/auth/passwordHash.js";
import { cancelarPedido } from "../../../src/domains/commerce/cancelarPedido.js";
import { crearPedido, type PaymentMethod } from "../../../src/domains/commerce/crearPedido.js";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import {
  invalidateConnectionsCache,
  saveConnection,
} from "../../../src/shared/db/connectionsDirectory.js";
import { createTemplateRecord } from "../../../src/shared/db/whatsappTemplatesDirectory.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { deleteProduct, seedProduct } from "../../helpers/seedCatalog.js";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const PHONE = "whatsapp:+573090000001";
const customerData = {
  address: "Calle 1 # 2-34",
  id_document: "123456789",
  full_name: "Cliente Cancelar Pedido",
  save_permanently: false,
};

let connectionId: string;
let adminId: string;
let customerId: string;
let conversationId: string;
let productId: string;
let variantId: string;
let settingsId: string;
const fetchMock = vi.fn();

async function getStock(): Promise<number> {
  const result = await adminPool.query<{ stock_quantity: number }>(
    `SELECT stock_quantity FROM inventory WHERE variant_id = $1`,
    [variantId],
  );
  return result.rows[0]!.stock_quantity;
}

async function nuevoPedido(paymentMethod: PaymentMethod, paymentStatusOverride?: string): Promise<string> {
  const quote = await generarCotizacion(conversationId, customerId, {
    items: [{ variant_id: variantId, quantity: 1 }],
  });
  const created = await crearPedido(
    `sid-cancelar-pedido-${Date.now()}-${Math.random()}`,
    {
      quote_id: quote.quote_id,
      payment_method: paymentMethod,
      delivery_method: "recoger_en_tienda",
      customer_data: customerData,
    },
    1000000,
  );
  const orderId = created.order_id!;
  if (paymentStatusOverride) {
    await adminPool.query(`UPDATE orders SET payment_status = $2 WHERE id = $1`, [orderId, paymentStatusOverride]);
  }
  return orderId;
}

async function getOrder(
  orderId: string,
): Promise<{ status: string; payment_status: string; cancellation_requested_at: Date | null }> {
  const result = await adminPool.query<{
    status: string;
    payment_status: string;
    cancellation_requested_at: Date | null;
  }>(`SELECT status, payment_status, cancellation_requested_at FROM orders WHERE id = $1`, [orderId]);
  return result.rows[0]!;
}

beforeAll(async () => {
  const settings = await adminPool.query<{ id: string }>(
    `INSERT INTO settings (name) VALUES ('Cancelar Pedido Test') RETURNING id`,
  );
  settingsId = settings.rows[0]!.id;

  const passwordHash = await hashPassword("clave-de-prueba-cancelar-pedido");
  adminId = await createAdmin(
    "admin-cancelar-pedido",
    "cancelar-pedido@formotos.test",
    passwordHash,
    "master",
    "whatsapp:+573099999999",
  );
  await updateAdminPermissions(adminId, {
    recibeReporteDiario: false,
    recibeTickets: true,
    recibeNotificacionPagos: false,
  });

  connectionId = await saveConnection({
    channel: "whatsapp",
    provider: "meta",
    label: "WhatsApp Cancelar Pedido Test · Meta",
    externalId: "555666777889111",
    displayAddress: "+57 300 444 5566",
    credentials: {
      phoneNumberId: "555666777889111",
      wabaId: "waba-cancelar-pedido-test",
      accessToken: "token-cancelar-pedido-test",
      appSecret: "secreto-cancelar-pedido-test",
      verifyToken: "verify-cancelar-pedido-test",
    },
  });

  const templateId = await createTemplateRecord({
    connectionId,
    name: "pedido_cancelado",
    category: "UTILITY",
    language: "es",
    components: [{ type: "BODY", text: "Tu pedido #{{1}} fue cancelado." }],
    createdByAdminId: adminId,
  });
  await adminPool.query(`UPDATE whatsapp_templates SET status = 'approved' WHERE id = $1`, [templateId]);

  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id) VALUES ($1) RETURNING id`,
    [PHONE],
  );
  customerId = customer.rows[0]!.id;
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id, connection_id, channel) VALUES ($1, $2, 'whatsapp') RETURNING id`,
    [customerId, connectionId],
  );
  conversationId = conversation.rows[0]!.id;

  const product = await seedProduct(adminPool, {
    sku: "CANCELAR-PEDIDO-1",
    name: "Casco cancelar pedido",
    price: 1000000,
    stock: 20,
  });
  productId = product.productId;
  variantId = product.variantId;
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: "wamid.pedido-cancelado" }] }));
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(sendToConversation).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await adminPool.query(
    `DELETE FROM handoff_tokens WHERE handoff_id IN (SELECT id FROM handoff_queue WHERE conversation_id = $1)`,
    [conversationId],
  );
  await adminPool.query(`DELETE FROM handoff_queue WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = $1)`, [conversationId]);
  await adminPool.query(`DELETE FROM orders WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`, [conversationId]);
  await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
  await deleteProduct(adminPool, productId);
  await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  await adminPool.query(`DELETE FROM channel_connections WHERE id = $1`, [connectionId]);
  invalidateConnectionsCache();
  await adminPool.query(`DELETE FROM admin_permissions WHERE admin_id = $1`, [adminId]);
  await adminPool.query(`DELETE FROM admins WHERE id = $1`, [adminId]);
  await adminPool.query(`DELETE FROM settings WHERE id = $1`, [settingsId]);
  await adminPool.end();
  await appPool.end();
});

describe("cancelarPedido", () => {
  it("transferencia pendiente (no pagado) -> cancela de inmediato y libera el stock", async () => {
    const orderId = await nuevoPedido("transferencia");
    const stockAntes = await getStock();

    const result = await cancelarPedido({ order_id: orderId });

    expect(result.status).toBe("cancelado");
    const order = await getOrder(orderId);
    expect(order.status).toBe("cancelado");
    expect(await getStock()).toBe(stockAntes + 1);
  });

  it("transferencia YA pagada -> no cancela de inmediato, queda pendiente de aprobación y escala a un admin", async () => {
    const orderId = await nuevoPedido("transferencia", "pagado");
    const stockAntes = await getStock();

    const result = await cancelarPedido({ order_id: orderId, reason: "cambié de opinión" });

    expect(result.status).toBe("cancelacion_pendiente_aprobacion");
    const order = await getOrder(orderId);
    expect(order.status).toBe("abierto"); // NO cambia todavía
    expect(order.payment_status).toBe("pagado");
    expect(order.cancellation_requested_at).not.toBeNull();
    expect(await getStock()).toBe(stockAntes); // no se libera todavía

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      "whatsapp:+573099999999",
      expect.stringContaining("cancelacion_pedido_pagado"),
    );

    const handoff = await adminPool.query<{ reason: string; status: string }>(
      `SELECT reason, status FROM handoff_queue WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [conversationId],
    );
    expect(handoff.rows[0]).toMatchObject({ reason: "cancelacion_pedido_pagado", status: "queued" });
  });

  it("una segunda solicitud sobre el mismo pedido pagado no duplica el ticket", async () => {
    const orderId = await nuevoPedido("transferencia", "pagado");
    await cancelarPedido({ order_id: orderId });
    vi.mocked(sendWhatsAppMessage).mockClear();

    const result = await cancelarPedido({ order_id: orderId });

    expect(result.status).toBe("cancelacion_pendiente_aprobacion");
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    const rows = await adminPool.query(`SELECT id FROM handoff_queue WHERE conversation_id = $1`, [conversationId]);
    expect(rows.rowCount).toBe(1);
  });

  it("efectivo_contraentrega (payment_status='pagado' por default, sin cobro real) -> cancela de inmediato igual", async () => {
    const orderId = await nuevoPedido("efectivo_contraentrega");
    const antes = await getOrder(orderId);
    expect(antes.payment_status).toBe("pagado"); // confirma el default histórico
    const stockAntes = await getStock();

    const result = await cancelarPedido({ order_id: orderId });

    expect(result.status).toBe("cancelado");
    expect(await getStock()).toBe(stockAntes + 1);
  });

  it("pedido ya cancelado -> pedido_no_abierto, sin tocar nada", async () => {
    const orderId = await nuevoPedido("efectivo_contraentrega");
    await cancelarPedido({ order_id: orderId });
    fetchMock.mockClear();

    const result = await cancelarPedido({ order_id: orderId });

    expect(result.status).toBe("pedido_no_abierto");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
