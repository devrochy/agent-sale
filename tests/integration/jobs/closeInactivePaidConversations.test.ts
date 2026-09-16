import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCloseInactivePaidConversations } from "../../../src/jobs/closeInactivePaidConversations.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const PHONES = {
  inactiva: "whatsapp:+573030000001",
  activaReciente: "whatsapp:+573030000002",
  conTicketAbierto: "whatsapp:+573030000003",
  sinPagar: "whatsapp:+573030000004",
};

interface Setup {
  conversationId: string;
}

const setups: Record<keyof typeof PHONES, Setup> = {} as never;

async function seedConversation(
  key: keyof typeof PHONES,
  opts: { paymentStatus: string; lastInboundHoursAgo: number | null },
): Promise<Setup> {
  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id) VALUES ($1) RETURNING id`,
    [PHONES[key]],
  );
  const customerId = customer.rows[0]!.id;

  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id, status) VALUES ($1, 'open') RETURNING id`,
    [customerId],
  );
  const conversationId = conversation.rows[0]!.id;

  const quote = await adminPool.query<{ id: string }>(
    `INSERT INTO quotes (conversation_id, customer_id, subtotal, total) VALUES ($1, $2, 50000, 50000) RETURNING id`,
    [conversationId, customerId],
  );
  await adminPool.query(
    `INSERT INTO orders (quote_id, conversation_id, customer_id, status, payment_method, payment_status, delivery_method, idempotency_key, total)
     VALUES ($1, $2, $3, 'abierto', 'transferencia', $4, 'recoger_en_tienda', $5, 50000)`,
    [quote.rows[0]!.id, conversationId, customerId, opts.paymentStatus, `close-inactive-test-${key}`],
  );

  if (opts.lastInboundHoursAgo !== null) {
    await adminPool.query(
      `INSERT INTO messages (conversation_id, direction, sender_type, content, created_at)
       VALUES ($1, 'inbound', 'customer', 'hola', now() - ($2 || ' hours')::interval)`,
      [conversationId, opts.lastInboundHoursAgo],
    );
  }

  return { conversationId };
}

beforeAll(async () => {
  setups.inactiva = await seedConversation("inactiva", { paymentStatus: "pagado", lastInboundHoursAgo: 13 });
  setups.activaReciente = await seedConversation("activaReciente", {
    paymentStatus: "pagado",
    lastInboundHoursAgo: 1,
  });
  setups.conTicketAbierto = await seedConversation("conTicketAbierto", {
    paymentStatus: "pagado",
    lastInboundHoursAgo: 13,
  });
  await adminPool.query(
    `INSERT INTO handoff_queue (conversation_id, reason, status, summary) VALUES ($1, 'queja', 'queued', 'ticket sin tomar')`,
    [setups.conTicketAbierto.conversationId],
  );
  setups.sinPagar = await seedConversation("sinPagar", { paymentStatus: "pendiente", lastInboundHoursAgo: 13 });
});

afterAll(async () => {
  const phones = Object.values(PHONES);
  await adminPool.query(
    `DELETE FROM handoff_tokens WHERE handoff_id IN (SELECT id FROM handoff_queue WHERE conversation_id IN (SELECT id FROM conversations WHERE customer_id IN (SELECT id FROM customers WHERE external_id = ANY($1))))`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM handoff_queue WHERE conversation_id IN (SELECT id FROM conversations WHERE customer_id IN (SELECT id FROM customers WHERE external_id = ANY($1)))`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE external_id = ANY($1))`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM quotes WHERE customer_id IN (SELECT id FROM customers WHERE external_id = ANY($1))`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM messages WHERE conversation_id IN (SELECT c.id FROM conversations c JOIN customers cu ON cu.id = c.customer_id WHERE cu.external_id = ANY($1))`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM conversations WHERE customer_id IN (SELECT id FROM customers WHERE external_id = ANY($1))`,
    [phones],
  );
  await adminPool.query(`DELETE FROM customers WHERE external_id = ANY($1)`, [phones]);
  await adminPool.end();
  await appPool.end();
});

async function getStatus(conversationId: string): Promise<string> {
  const result = await adminPool.query<{ status: string }>(`SELECT status FROM conversations WHERE id = $1`, [
    conversationId,
  ]);
  return result.rows[0]!.status;
}

describe("runCloseInactivePaidConversations", () => {
  it("cierra la conversación pagada sin actividad hace más de 12h", async () => {
    await runCloseInactivePaidConversations();
    expect(await getStatus(setups.inactiva.conversationId)).toBe("closed");
  });

  it("no toca la conversación pagada con actividad reciente", async () => {
    expect(await getStatus(setups.activaReciente.conversationId)).toBe("open");
  });

  it("no toca la conversación con un ticket todavía sin tomar (queued)", async () => {
    expect(await getStatus(setups.conTicketAbierto.conversationId)).toBe("open");
  });

  it("no toca la conversación cuyo pedido sigue sin pagar", async () => {
    expect(await getStatus(setups.sinPagar.conversationId)).toBe("open");
  });
});
