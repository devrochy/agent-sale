import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  getWhatsAppMessageStatus: vi.fn(),
}));

import { getWhatsAppMessageStatus, sendWhatsAppMessage } from "../../../src/gateway/sendMessage.js";
import { runCazadorDeVentas } from "../../../src/jobs/cazadorDeVentas.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let tenantId: string;
let productId: string;

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
    `INSERT INTO customers (tenant_id, phone_number) VALUES ($1, $2) RETURNING id`,
    [tenantId, PHONES[key]],
  );
  const customerId = customer.rows[0]!.id;

  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id`,
    [tenantId, customerId],
  );
  const conversationId = conversation.rows[0]!.id;

  if (opts.lastCustomerMessageHoursAgo !== null) {
    await adminPool.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content, created_at)
       VALUES ($1, $2, 'inbound', 'customer', 'hola, cuánto cuesta?', now() - ($3 || ' hours')::interval)`,
      [tenantId, conversationId, opts.lastCustomerMessageHoursAgo],
    );
  }

  const quote = await adminPool.query<{ id: string }>(
    `INSERT INTO quotes (tenant_id, conversation_id, customer_id, subtotal, total, created_at, follow_up_sent_at)
     VALUES ($1, $2, $3, 50000, 50000, now() - ($4 || ' hours')::interval, $5)
     RETURNING id`,
    [
      tenantId,
      conversationId,
      customerId,
      opts.quoteAgeHours,
      opts.followUpAlreadySent ? new Date() : null,
    ],
  );
  const quoteId = quote.rows[0]!.id;

  await adminPool.query(
    `INSERT INTO quote_items (tenant_id, quote_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, 1, 50000)`,
    [tenantId, quoteId, productId],
  );

  if (opts.withOrder) {
    await adminPool.query(
      `INSERT INTO orders
         (tenant_id, quote_id, conversation_id, customer_id, payment_method, delivery_method, idempotency_key, total)
       VALUES ($1, $2, $3, $4, 'transferencia', 'domicilio', $5, 50000)`,
      [tenantId, quoteId, conversationId, customerId, `cazador-test-${key}`],
    );
  }

  return { quoteId, conversationId };
}

beforeAll(async () => {
  const tenant = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Cazador Ventas Test') RETURNING id`,
  );
  tenantId = tenant.rows[0]!.id;

  const product = await adminPool.query<{ id: string }>(
    `INSERT INTO products (tenant_id, sku, name, price) VALUES ($1, 'CV-1', 'Guantes de prueba', 50000) RETURNING id`,
    [tenantId],
  );
  productId = product.rows[0]!.id;

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
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(getWhatsAppMessageStatus).mockReset();
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM orders WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM quote_items WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM quotes WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM messages WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM conversations WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM products WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM customers WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  await adminPool.end();
  await appPool.end();
});

describe("runCazadorDeVentas", () => {
  it("manda el reenganche solo a la cotización que cumple todas las condiciones", async () => {
    vi.mocked(sendWhatsAppMessage).mockImplementation(async (to) => {
      if (to === PHONES.envioFalla) {
        throw new Error("Twilio no disponible (simulado)");
      }
      return "SM_TEST_SID";
    });
    vi.mocked(getWhatsAppMessageStatus).mockResolvedValue({ status: "delivered", errorCode: null });

    await runCazadorDeVentas();

    // Único candidato que debía recibir el mensaje: cotización de 5h, sin
    // pedido, cliente activo hace 2h, sin follow_up_sent_at previo.
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(2); // "valido" + "envioFalla" (este último lanza)
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      PHONES.valido,
      expect.stringContaining("Guantes de prueba"),
    );
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONES.envioFalla, expect.any(String));
    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(PHONES.conPedido, expect.any(String));
    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(PHONES.muyReciente, expect.any(String));
    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(PHONES.vencida, expect.any(String));
    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(
      PHONES.clienteInactivo,
      expect.any(String),
    );
    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(PHONES.yaEnviado, expect.any(String));
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
    vi.mocked(sendWhatsAppMessage).mockResolvedValue("SM_TEST_SID_2");
    vi.mocked(getWhatsAppMessageStatus).mockResolvedValue({ status: "delivered", errorCode: null });

    await runCazadorDeVentas();

    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(PHONES.valido, expect.any(String));
  });
});
