import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendToConversation: vi.fn(),
  getWhatsAppMessageStatus: vi.fn(),
}));

import { sendToConversation } from "../../../src/gateway/sendMessage.js";
import { crearPedido } from "../../../src/domains/commerce/crearPedido.js";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import { registrarGuia } from "../../../src/domains/commerce/registrarGuia.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { deleteProduct, seedProduct } from "../../helpers/seedCatalog.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const customerData = {
  address: "Calle 1 # 2-34",
  id_document: "123456789",
  full_name: "Cliente Guia",
  save_permanently: false,
};

const PHONE = "whatsapp:+573060000001";

let conversationId: string;
let customerId: string;
let productId: string;
let variantId: string;
let orderId: string;
let publicOrderNumber: string;

beforeAll(async () => {
  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id) VALUES ($1) RETURNING id`,
    [PHONE],
  );
  customerId = customer.rows[0]!.id;
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerId],
  );
  conversationId = conversation.rows[0]!.id;

  const product = await seedProduct(adminPool, {
    sku: "REGISTRAR-GUIA-1",
    name: "Casco registrar guía",
    price: 100000,
    stock: 20,
  });
  productId = product.productId;
  variantId = product.variantId;

  const quote = await generarCotizacion(conversationId, customerId, {
    items: [{ variant_id: variantId, quantity: 1 }],
  });
  const created = await crearPedido(
    "sid-registrar-guia-1",
    {
      quote_id: quote.quote_id,
      payment_method: "transferencia",
      delivery_method: "domicilio",
      customer_data: customerData,
    },
    1000000,
  );
  orderId = created.order_id!;
  publicOrderNumber = created.public_order_number!;
});

afterEach(() => {
  vi.mocked(sendToConversation).mockReset();
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM order_items WHERE order_id = $1`, [orderId]);
  await adminPool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
  await adminPool.query(
    `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`,
    [conversationId],
  );
  await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM messages WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
  await deleteProduct(adminPool, productId);
  await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  await adminPool.end();
  await appPool.end();
});

describe("registrarGuia", () => {
  it("primera vez: setea shipped_at, notifica por WhatsApp y guarda en el historial", async () => {
    vi.mocked(sendToConversation).mockResolvedValue("SM_TEST_SID");

    const result = await registrarGuia(orderId, { trackingNumber: "GUIA-001", carrier: "Servientrega" });

    expect(result).toEqual({ ok: true });

    const order = await adminPool.query<{
      tracking_number: string;
      carrier: string;
      shipped_at: Date | null;
    }>(`SELECT tracking_number, carrier, shipped_at FROM orders WHERE id = $1`, [orderId]);
    expect(order.rows[0]!.tracking_number).toBe("GUIA-001");
    expect(order.rows[0]!.carrier).toBe("Servientrega");
    expect(order.rows[0]!.shipped_at).not.toBeNull();

    expect(sendToConversation).toHaveBeenCalledTimes(1);
    expect(sendToConversation).toHaveBeenCalledWith(conversationId, expect.stringContaining(publicOrderNumber));
    expect(sendToConversation).toHaveBeenCalledWith(conversationId, expect.stringContaining("GUIA-001"));

    const messages = await adminPool.query<{ content: string; sender_type: string }>(
      `SELECT content, sender_type FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`,
      [conversationId],
    );
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0]!.sender_type).toBe("agent");
  });

  it("segunda vez (corregir guía): actualiza los campos sin volver a notificar ni cambiar shipped_at", async () => {
    const before = await adminPool.query<{ shipped_at: Date }>(`SELECT shipped_at FROM orders WHERE id = $1`, [
      orderId,
    ]);
    const shippedAtAntes = before.rows[0]!.shipped_at;

    const result = await registrarGuia(orderId, { trackingNumber: "GUIA-002", carrier: "Coordinadora" });

    expect(result).toEqual({ ok: true });
    expect(sendToConversation).not.toHaveBeenCalled();

    const order = await adminPool.query<{
      tracking_number: string;
      carrier: string;
      shipped_at: Date;
    }>(`SELECT tracking_number, carrier, shipped_at FROM orders WHERE id = $1`, [orderId]);
    expect(order.rows[0]!.tracking_number).toBe("GUIA-002");
    expect(order.rows[0]!.carrier).toBe("Coordinadora");
    expect(order.rows[0]!.shipped_at).toEqual(shippedAtAntes);

    const messages = await adminPool.query(
      `SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`,
      [conversationId],
    );
    expect(messages.rows).toHaveLength(1); // sigue siendo solo el de la primera vez
  });

  it("pedido inexistente devuelve ok:false sin lanzar", async () => {
    const result = await registrarGuia("00000000-0000-0000-0000-000000000000", {
      trackingNumber: "GUIA-003",
      carrier: "Servientrega",
    });
    expect(result).toEqual({ ok: false, error: "Pedido no encontrado." });
  });
});
