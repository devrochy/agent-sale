import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendToConversation: vi.fn(),
  getWhatsAppMessageStatus: vi.fn(),
}));

import { getWhatsAppMessageStatus, sendToConversation } from "../../../src/gateway/sendMessage.js";
import { runCazadorDeVentas } from "../../../src/jobs/cazadorDeVentas.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { deleteProduct, seedProduct } from "../../helpers/seedCatalog.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let productId: string;
let variantId: string;

const PHONES = {
  valido: "whatsapp:+573010000001",
  conPedido: "whatsapp:+573010000002",
  muyReciente: "whatsapp:+573010000003",
  vencida: "whatsapp:+573010000004",
  clienteInactivo: "whatsapp:+573010000005",
  yaEnviado: "whatsapp:+573010000006",
  envioFalla: "whatsapp:+573010000007",
};

interface Setup {
  quoteId: string;
  conversationId: string;
}

const setups: Record<keyof typeof PHONES, Setup> = {} as never;

async function seedCase(
  key: keyof typeof PHONES,
  opts: {
    quoteAgeHours: number;
    lastCustomerMessageHoursAgo: number | null;
    withOrder?: boolean;
    followUpAlreadySent?: boolean;
  },
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

  if (opts.lastCustomerMessageHoursAgo !== null) {
    await adminPool.query(
      `INSERT INTO messages (conversation_id, direction, sender_type, content, created_at)
       VALUES ($1, 'inbound', 'customer', 'hola, cuánto cuesta?', now() - ($2 || ' hours')::interval)`,
      [conversationId, opts.lastCustomerMessageHoursAgo],
    );
  }

  const quote = await adminPool.query<{ id: string }>(
    `INSERT INTO quotes (conversation_id, customer_id, subtotal, total, created_at, follow_up_sent_at)
     VALUES ($1, $2, 50000, 50000, now() - ($3 || ' hours')::interval, $4)
     RETURNING id`,
    [conversationId, customerId, opts.quoteAgeHours, opts.followUpAlreadySent ? new Date() : null],
  );
  const quoteId = quote.rows[0]!.id;

  await adminPool.query(
    `INSERT INTO quote_items (quote_id, variant_id, quantity, unit_price) VALUES ($1, $2, 1, 50000)`,
    [quoteId, variantId],
  );

  if (opts.withOrder) {
    await adminPool.query(
      `INSERT INTO orders
         (quote_id, conversation_id, customer_id, payment_method, delivery_method, idempotency_key, total)
       VALUES ($1, $2, $3, 'transferencia', 'domicilio', $4, 50000)`,
      [quoteId, conversationId, customerId, `cazador-test-${key}`],
    );
  }

  return { quoteId, conversationId };
}

beforeAll(async () => {
  const product = await seedProduct(adminPool, {
    sku: "CV-1",
    name: "Guantes de prueba",
    price: 50000,
    stock: 0,
  });
  productId = product.productId;
  variantId = product.variantId;

  setups.valido = await seedCase("valido", { quoteAgeHours: 5, lastCustomerMessageHoursAgo: 2 });
  setups.conPedido = await seedCase("conPedido", {
    quoteAgeHours: 5,
    lastCustomerMessageHoursAgo: 2,
    withOrder: true,
  });
  setups.muyReciente = await seedCase("muyReciente", {
    quoteAgeHours: 1,
    lastCustomerMessageHoursAgo: 0.5,
  });
  setups.vencida = await seedCase("vencida", { quoteAgeHours: 22, lastCustomerMessageHoursAgo: 1 });
  setups.clienteInactivo = await seedCase("clienteInactivo", {
    quoteAgeHours: 5,
    lastCustomerMessageHoursAgo: 30,
  });
  setups.yaEnviado = await seedCase("yaEnviado", {
    quoteAgeHours: 5,
    lastCustomerMessageHoursAgo: 2,
    followUpAlreadySent: true,
  });
  setups.envioFalla = await seedCase("envioFalla", {
    quoteAgeHours: 5,
    lastCustomerMessageHoursAgo: 2,
  });
});

afterEach(() => {
  vi.mocked(sendToConversation).mockReset();
  vi.mocked(getWhatsAppMessageStatus).mockReset();
});

afterAll(async () => {
  const phones = Object.values(PHONES);
  await adminPool.query(
    `DELETE FROM orders WHERE conversation_id IN (
       SELECT c.id FROM conversations c JOIN customers cu ON cu.id = c.customer_id
       WHERE cu.phone_number = ANY($1)
     )`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM quote_items WHERE quote_id IN (
       SELECT q.id FROM quotes q
       JOIN conversations c ON c.id = q.conversation_id
       JOIN customers cu ON cu.id = c.customer_id
       WHERE cu.phone_number = ANY($1)
     )`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM quotes WHERE conversation_id IN (
       SELECT c.id FROM conversations c JOIN customers cu ON cu.id = c.customer_id
       WHERE cu.phone_number = ANY($1)
     )`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM messages WHERE conversation_id IN (
       SELECT c.id FROM conversations c JOIN customers cu ON cu.id = c.customer_id
       WHERE cu.phone_number = ANY($1)
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

describe("runCazadorDeVentas", () => {
  it("manda el reenganche solo a la cotización que cumple todas las condiciones", async () => {
    vi.mocked(sendToConversation).mockImplementation(async (conversationId) => {
      if (conversationId === setups.envioFalla.conversationId) {
        throw new Error("Twilio no disponible (simulado)");
      }
      return "SM_TEST_SID";
    });
    vi.mocked(getWhatsAppMessageStatus).mockResolvedValue({ status: "delivered", errorCode: null });

    await runCazadorDeVentas();

    // Único candidato que debía recibir el mensaje: cotización de 5h, sin
    // pedido, cliente activo hace 2h, sin follow_up_sent_at previo.
    expect(sendToConversation).toHaveBeenCalledTimes(2); // "valido" + "envioFalla" (este último lanza)
    expect(sendToConversation).toHaveBeenCalledWith(
      setups.valido.conversationId,
      expect.stringContaining("Guantes de prueba"),
    );
    expect(sendToConversation).toHaveBeenCalledWith(setups.envioFalla.conversationId, expect.any(String));
    expect(sendToConversation).not.toHaveBeenCalledWith(setups.conPedido.conversationId, expect.any(String));
    expect(sendToConversation).not.toHaveBeenCalledWith(setups.muyReciente.conversationId, expect.any(String));
    expect(sendToConversation).not.toHaveBeenCalledWith(setups.vencida.conversationId, expect.any(String));
    expect(sendToConversation).not.toHaveBeenCalledWith(
      setups.clienteInactivo.conversationId,
      expect.any(String),
    );
    expect(sendToConversation).not.toHaveBeenCalledWith(setups.yaEnviado.conversationId, expect.any(String));
  });

  it("marca follow_up_sent_at solo para el envío que no lanzó", async () => {
    const quotes = await adminPool.query<{ id: string; follow_up_sent_at: Date | null }>(
      `SELECT id, follow_up_sent_at FROM quotes WHERE id = ANY($1)`,
      [[setups.valido.quoteId, setups.envioFalla.quoteId]],
    );
    const byId = new Map(quotes.rows.map((r) => [r.id, r.follow_up_sent_at]));

    expect(byId.get(setups.valido.quoteId)).not.toBeNull();
    expect(byId.get(setups.envioFalla.quoteId)).toBeNull();
  });

  it("guarda el mensaje de reenganche en el historial de la conversación", async () => {
    const messages = await adminPool.query<{
      content: string;
      sender_type: string;
      direction: string;
    }>(
      `SELECT content, sender_type, direction FROM messages
       WHERE conversation_id = $1 AND direction = 'outbound'`,
      [setups.valido.conversationId],
    );
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0]!.sender_type).toBe("agent");
    expect(messages.rows[0]!.content).toContain("Guantes de prueba");
  });

  it("una segunda corrida no vuelve a mandarle a la cotización ya marcada", async () => {
    vi.mocked(sendToConversation).mockResolvedValue("SM_TEST_SID_2");
    vi.mocked(getWhatsAppMessageStatus).mockResolvedValue({ status: "delivered", errorCode: null });

    await runCazadorDeVentas();

    expect(sendToConversation).not.toHaveBeenCalledWith(setups.valido.conversationId, expect.any(String));
  });
});
