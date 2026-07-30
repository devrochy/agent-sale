import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
}));

import { sendWhatsAppMessage } from "../../../src/gateway/sendMessage.js";
import { buildServer } from "../../../src/gateway/server.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { saveReportRecipient, saveWompiConfig } from "../../../src/shared/db/tenantsDirectory.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const EVENTS_SECRET = "test_events_wompiwebhooktest";
const PROPERTIES = ["transaction.id", "transaction.status", "transaction.amount_in_cents"];

function checksumFor(
  transactionId: string,
  status: string,
  amountInCents: number,
  timestamp: number,
): string {
  const concatenated = `${transactionId}${status}${amountInCents}${timestamp}${EVENTS_SECRET}`;
  return createHash("sha256").update(concatenated).digest("hex");
}

function buildEvent(
  transactionId: string,
  status: string,
  paymentLinkId: string | null,
  amountInCents = 100000,
) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    event: "transaction.updated",
    data: {
      transaction: {
        id: transactionId,
        status,
        amount_in_cents: amountInCents,
        payment_link_id: paymentLinkId,
      },
    },
    signature: {
      properties: PROPERTIES,
      checksum: checksumFor(transactionId, status, amountInCents, timestamp),
    },
    timestamp,
  };
}

let tenantId: string;
let orderId: string;
let quoteId: string;
const PAYMENT_LINK_ID = `link-webhook-test-${Date.now()}`;
const app = await buildServer();

beforeAll(async () => {
  const tenant = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Wompi Webhook Test') RETURNING id`,
  );
  tenantId = tenant.rows[0]!.id;
  await saveWompiConfig(tenantId, { privateKey: "prv_test_fake", eventsSecret: EVENTS_SECRET });
  await saveReportRecipient(tenantId, "whatsapp:+573000000002");

  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, phone_number) VALUES ($1, '3050000001') RETURNING id`,
    [tenantId],
  );
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id`,
    [tenantId, customer.rows[0]!.id],
  );
  const quote = await adminPool.query<{ id: string }>(
    `INSERT INTO quotes (tenant_id, conversation_id, customer_id, subtotal, total) VALUES ($1, $2, $3, 1000, 1000) RETURNING id`,
    [tenantId, conversation.rows[0]!.id, customer.rows[0]!.id],
  );
  quoteId = quote.rows[0]!.id;
  const order = await adminPool.query<{ id: string }>(
    `INSERT INTO orders (tenant_id, quote_id, conversation_id, customer_id, status, payment_method, payment_status, delivery_method, idempotency_key, total, wompi_payment_link_id)
     VALUES ($1, $2, $3, $4, 'confirmed', 'pago_en_linea', 'pendiente', 'domicilio', $5, 1000, $6)
     RETURNING id`,
    [
      tenantId,
      quoteId,
      conversation.rows[0]!.id,
      customer.rows[0]!.id,
      `idem-wompi-webhook-${Date.now()}`,
      PAYMENT_LINK_ID,
    ],
  );
  orderId = order.rows[0]!.id;
  await adminPool.query(
    `INSERT INTO wompi_payment_links (payment_link_id, tenant_id, order_id) VALUES ($1, $2, $3)`,
    [PAYMENT_LINK_ID, tenantId, orderId],
  );
  await app.ready();
});

afterEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM wompi_payment_links WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM orders WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM quotes WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM conversations WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM customers WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  await app.close();
  await adminPool.end();
  await appPool.end();
});

async function post(body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/webhooks/wompi",
    headers: { "content-type": "application/json" },
    payload: body,
  });
}

async function paymentStatus(): Promise<string> {
  const result = await adminPool.query<{ payment_status: string }>(
    `SELECT payment_status FROM orders WHERE id = $1`,
    [orderId],
  );
  return result.rows[0]!.payment_status;
}

describe("POST /webhooks/wompi", () => {
  it("payment_link_id desconocido responde 200 sin tocar ningún pedido", async () => {
    const event = buildEvent("tx-unknown", "APPROVED", "link-que-no-existe");
    const response = await post(event);
    expect(response.statusCode).toBe(200);
    expect(await paymentStatus()).toBe("pendiente");
  });

  it("checksum inválido responde 400 y no marca el pedido como pagado", async () => {
    const event = buildEvent("tx-bad-checksum", "APPROVED", PAYMENT_LINK_ID);
    event.signature.checksum = `${event.signature.checksum.slice(0, -1)}0`;

    const response = await post(event);
    expect(response.statusCode).toBe(400);
    expect(await paymentStatus()).toBe("pendiente");
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("transacción DECLINED responde 200 pero no marca el pedido como pagado", async () => {
    const event = buildEvent("tx-declined", "DECLINED", PAYMENT_LINK_ID);
    const response = await post(event);
    expect(response.statusCode).toBe(200);
    expect(await paymentStatus()).toBe("pendiente");
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("transacción APPROVED con checksum válido marca el pedido como pagado y notifica al operador", async () => {
    const event = buildEvent("tx-approved-1", "APPROVED", PAYMENT_LINK_ID);
    const response = await post(event);

    expect(response.statusCode).toBe(200);
    expect(await paymentStatus()).toBe("pagado");
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      "whatsapp:+573000000002",
      expect.stringContaining(orderId),
    );

    const row = await adminPool.query<{ wompi_transaction_id: string; paid_at: string | null }>(
      `SELECT wompi_transaction_id, paid_at FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(row.rows[0]!.wompi_transaction_id).toBe("tx-approved-1");
    expect(row.rows[0]!.paid_at).not.toBeNull();
  });

  it("un reintento del mismo evento (ya pagado) responde 200 y no vuelve a notificar", async () => {
    const event = buildEvent("tx-approved-1", "APPROVED", PAYMENT_LINK_ID);
    const response = await post(event);

    expect(response.statusCode).toBe(200);
    expect(await paymentStatus()).toBe("pagado");
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });
});
