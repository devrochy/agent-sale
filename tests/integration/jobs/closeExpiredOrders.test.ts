import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendToConversation: vi.fn(),
  getWhatsAppMessageStatus: vi.fn(),
}));

import { sendToConversation } from "../../../src/gateway/sendMessage.js";
import { runCloseExpiredOrders } from "../../../src/jobs/closeExpiredOrders.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { deleteProduct, seedProduct } from "../../helpers/seedCatalog.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const STOCK_INICIAL = 20;

let productId: string;
let variantId: string;

const PHONES = {
  vencida: "whatsapp:+573020000001",
  reciente: "whatsapp:+573020000002",
  transferenciaVencida: "whatsapp:+573020000003",
  pagadaWompi: "whatsapp:+573020000004",
};

interface Setup {
  orderId: string;
  conversationId: string;
  publicOrderNumber: string;
}

const setups: Record<keyof typeof PHONES, Setup> = {} as never;

async function seedOrder(
  key: keyof typeof PHONES,
  opts: { paymentMethod: string; paymentStatus: string; ageDays: number },
): Promise<Setup> {
  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (phone_number) VALUES ($1) RETURNING id`,
    [PHONES[key]],
  );
  const customerId = customer.rows[0]!.id;

  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerId],
  );
  const conversationId = conversation.rows[0]!.id;

  const quote = await adminPool.query<{ id: string }>(
    `INSERT INTO quotes (conversation_id, customer_id, subtotal, total) VALUES ($1, $2, 50000, 50000) RETURNING id`,
    [conversationId, customerId],
  );
  const quoteId = quote.rows[0]!.id;

  await adminPool.query(
    `INSERT INTO quote_items (quote_id, variant_id, quantity, unit_price) VALUES ($1, $2, 1, 50000)`,
    [quoteId, variantId],
  );

  const order = await adminPool.query<{ id: string; public_order_number: string }>(
    `INSERT INTO orders
       (quote_id, conversation_id, customer_id, status, payment_method, payment_status, delivery_method, idempotency_key, total, created_at)
     VALUES ($1, $2, $3, 'abierto', $4, $5, 'domicilio', $6, 50000, now() - ($7 || ' days')::interval)
     RETURNING id, public_order_number`,
    [quoteId, conversationId, customerId, opts.paymentMethod, opts.paymentStatus, `close-expired-test-${key}`, opts.ageDays],
  );
  const orderId = order.rows[0]!.id;
  const publicOrderNumber = order.rows[0]!.public_order_number;

  await adminPool.query(
    `INSERT INTO order_items (order_id, variant_id, quantity, unit_price) VALUES ($1, $2, 1, 50000)`,
    [orderId, variantId],
  );

  return { orderId, conversationId, publicOrderNumber };
}

async function getOrder(orderId: string): Promise<{ status: string }> {
  const result = await adminPool.query<{ status: string }>(`SELECT status FROM orders WHERE id = $1`, [orderId]);
  return result.rows[0]!;
}

async function getStock(): Promise<number> {
  const result = await adminPool.query<{ stock_quantity: number }>(
    `SELECT stock_quantity FROM inventory WHERE variant_id = $1`,
    [variantId],
  );
  return result.rows[0]!.stock_quantity;
}

beforeAll(async () => {
  const product = await seedProduct(adminPool, {
    sku: "CEO-1",
    name: "Casco cierre automático",
    price: 50000,
    stock: STOCK_INICIAL,
  });
  productId = product.productId;
  variantId = product.variantId;

  setups.vencida = await seedOrder("vencida", {
    paymentMethod: "pago_en_linea",
    paymentStatus: "pendiente",
    ageDays: 6,
  });
  setups.reciente = await seedOrder("reciente", {
    paymentMethod: "pago_en_linea",
    paymentStatus: "pendiente",
    ageDays: 3,
  });
  setups.transferenciaVencida = await seedOrder("transferenciaVencida", {
    paymentMethod: "transferencia",
    paymentStatus: "pagado",
    ageDays: 6,
  });
  setups.pagadaWompi = await seedOrder("pagadaWompi", {
    paymentMethod: "pago_en_linea",
    paymentStatus: "pagado",
    ageDays: 6,
  });
});

afterEach(() => {
  vi.mocked(sendToConversation).mockReset();
});

afterAll(async () => {
  const phones = Object.values(PHONES);
  await adminPool.query(
    `DELETE FROM order_items WHERE order_id IN (
       SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.phone_number = ANY($1)
     )`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE phone_number = ANY($1))`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM quote_items WHERE quote_id IN (
       SELECT q.id FROM quotes q JOIN customers c ON c.id = q.customer_id WHERE c.phone_number = ANY($1)
     )`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM quotes WHERE customer_id IN (SELECT id FROM customers WHERE phone_number = ANY($1))`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM messages WHERE conversation_id IN (
       SELECT c.id FROM conversations c JOIN customers cu ON cu.id = c.customer_id WHERE cu.phone_number = ANY($1)
     )`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM conversations WHERE customer_id IN (SELECT id FROM customers WHERE phone_number = ANY($1))`,
    [phones],
  );
  await adminPool.query(`DELETE FROM customers WHERE phone_number = ANY($1)`, [phones]);
  await deleteProduct(adminPool, productId);
  await adminPool.end();
  await appPool.end();
});

describe("runCloseExpiredOrders", () => {
  it("cierra, libera stock y notifica solo el pedido pago_en_linea pendiente de 6 días", async () => {
    vi.mocked(sendToConversation).mockResolvedValue("SM_TEST_SID");

    await runCloseExpiredOrders();

    const vencida = await getOrder(setups.vencida.orderId);
    expect(vencida.status).toBe("expirado");
    expect(await getStock()).toBe(STOCK_INICIAL + 1);

    expect(sendToConversation).toHaveBeenCalledTimes(1);
    expect(sendToConversation).toHaveBeenCalledWith(
      setups.vencida.conversationId,
      expect.stringContaining(setups.vencida.publicOrderNumber),
    );

    const reciente = await getOrder(setups.reciente.orderId);
    expect(reciente.status).toBe("abierto");

    const transferenciaVencida = await getOrder(setups.transferenciaVencida.orderId);
    expect(transferenciaVencida.status).toBe("abierto");

    const pagadaWompi = await getOrder(setups.pagadaWompi.orderId);
    expect(pagadaWompi.status).toBe("abierto");
  });

  it("guarda la notificación de expiración en el historial de la conversación", async () => {
    const messages = await adminPool.query<{ content: string; sender_type: string; direction: string }>(
      `SELECT content, sender_type, direction FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`,
      [setups.vencida.conversationId],
    );
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0]!.sender_type).toBe("agent");
    expect(messages.rows[0]!.content).toContain(setups.vencida.publicOrderNumber);
  });

  it("una segunda corrida sobre un pedido ya expirado no vuelve a liberar stock ni a notificar", async () => {
    vi.mocked(sendToConversation).mockResolvedValue("SM_TEST_SID_2");

    const stockAntes = await getStock();
    await runCloseExpiredOrders();

    expect(await getStock()).toBe(stockAntes);
    expect(sendToConversation).not.toHaveBeenCalledWith(setups.vencida.conversationId, expect.any(String));
  });
});
