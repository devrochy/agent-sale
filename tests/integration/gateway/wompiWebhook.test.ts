import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
}));

import { createAdmin, updateAdminPermissions } from "../../../src/admin/auth/adminsDirectory.js";
import { hashPassword } from "../../../src/admin/auth/passwordHash.js";
import { sendWhatsAppMessage } from "../../../src/gateway/sendMessage.js";
import { buildServer } from "../../../src/gateway/server.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { saveReportRecipient, saveWompiConfig } from "../../../src/shared/db/settingsDirectory.js";

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

let settingsId: string;
let customerId: string;
let conversationId: string;
let orderId: string;
let quoteId: string;
const PAYMENT_LINK_ID = `link-webhook-test-${Date.now()}`;
const app = await buildServer();

beforeAll(async () => {
  const settings = await adminPool.query<{ id: string }>(
    `INSERT INTO settings (name) VALUES ('Wompi Webhook Test') RETURNING id`,
  );
  settingsId = settings.rows[0]!.id;
  await saveWompiConfig({ privateKey: "prv_test_fake", eventsSecret: EVENTS_SECRET });
  await saveReportRecipient("whatsapp:+573000000002");

  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id) VALUES ('3050000001') RETURNING id`,
  );
  customerId = customer.rows[0]!.id;
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerId],
  );
  conversationId = conversation.rows[0]!.id;
  const quote = await adminPool.query<{ id: string }>(
    `INSERT INTO quotes (conversation_id, customer_id, subtotal, total) VALUES ($1, $2, 1000, 1000) RETURNING id`,
    [conversationId, customerId],
  );
  quoteId = quote.rows[0]!.id;
  const order = await adminPool.query<{ id: string }>(
    `INSERT INTO orders (quote_id, conversation_id, customer_id, status, payment_method, payment_status, delivery_method, idempotency_key, total, wompi_payment_link_id)
     VALUES ($1, $2, $3, 'abierto', 'pago_en_linea', 'pendiente', 'domicilio', $4, 1000, $5)
     RETURNING id`,
    [quoteId, conversationId, customerId, `idem-wompi-webhook-${Date.now()}`, PAYMENT_LINK_ID],
  );
  orderId = order.rows[0]!.id;
  await adminPool.query(`INSERT INTO wompi_payment_links (payment_link_id, order_id) VALUES ($1, $2)`, [
    PAYMENT_LINK_ID,
    orderId,
  ]);
  await app.ready();
});

afterEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM wompi_payment_links WHERE order_id = $1`, [orderId]);
  await adminPool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
  await adminPool.query(`DELETE FROM quotes WHERE id = $1`, [quoteId]);
  await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  await adminPool.query(`DELETE FROM settings WHERE id = $1`, [settingsId]);
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
    const original = event.signature.checksum;
    // Evita el caso borde en que el último caracter del hash real ya sea
    // "0" (1/16 de las corridas): ahí "slice(0,-1) + '0'" reconstruiría el
    // mismo checksum válido y el test dejaría de probar lo que dice probar.
    event.signature.checksum = original.slice(0, -1) + (original.endsWith("0") ? "1" : "0");

    const response = await post(event);
    expect(response.statusCode).toBe(400);
    expect(await paymentStatus()).toBe("pendiente");
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("transacción DECLINED marca el pedido como rechazado y avisa", async () => {
    // Pedido propio: marcar rechazado es un cambio real de estado, y sobre
    // el pedido compartido dejaría a los tests de APPROVED sin nada que
    // aprobar (el guard es `payment_status = 'pendiente'`).
    const linkId = `link-declined-${Date.now()}`;
    const order = await adminPool.query<{ id: string }>(
      `INSERT INTO orders (quote_id, conversation_id, customer_id, status, payment_method, payment_status, delivery_method, idempotency_key, total, wompi_payment_link_id)
       VALUES ($1, $2, $3, 'abierto', 'pago_en_linea', 'pendiente', 'domicilio', $4, 1000, $5)
       RETURNING id`,
      [quoteId, conversationId, customerId, `idem-declined-${Date.now()}`, linkId],
    );
    const declinedOrderId = order.rows[0]!.id;
    await adminPool.query(
      `INSERT INTO wompi_payment_links (payment_link_id, order_id) VALUES ($1, $2)`,
      [linkId, declinedOrderId],
    );

    const response = await post(buildEvent("tx-declined", "DECLINED", linkId));
    expect(response.statusCode).toBe(200);

    // Antes se descartaba con un log: el pedido se quedaba "pendiente de
    // pago" hasta que el job de los 5 días lo vencía, y nadie se enteraba
    // de que el pago había rebotado hoy.
    const fila = await adminPool.query<{ payment_status: string; status_reason: string | null }>(
      `SELECT payment_status, status_reason FROM orders WHERE id = $1`,
      [declinedOrderId],
    );
    expect(fila.rows[0]!.payment_status).toBe("rechazado");
    expect(fila.rows[0]!.status_reason).toContain("DECLINED");
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);

    // Y el pedido compartido, intacto: el rechazo no toca a nadie más.
    expect(await paymentStatus()).toBe("pendiente");

    await adminPool.query(`DELETE FROM wompi_payment_links WHERE order_id = $1`, [declinedOrderId]);
    await adminPool.query(`DELETE FROM orders WHERE id = $1`, [declinedOrderId]);
  });

  it("PENDING no toca el pedido — es transitorio y Wompi manda otro evento al resolver", async () => {
    const response = await post(buildEvent("tx-pending", "PENDING", PAYMENT_LINK_ID));
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

describe("POST /webhooks/wompi — notificación a admins con permiso (Fase 13)", () => {
  let orderId2: string;
  let quoteId2: string;
  let conversationId2: string;
  let customerId2: string;
  let adminId: string;
  const PAYMENT_LINK_ID_2 = `link-webhook-test-admins-${Date.now()}`;

  beforeAll(async () => {
    const passwordHash = await hashPassword("clave-de-prueba-admin-pagos");
    adminId = await createAdmin(
      "pagos-webhook-test",
      "pagos@formotos-test.com",
      passwordHash,
      "colaborador",
      "whatsapp:+573000000098",
    );
    await updateAdminPermissions(adminId, {
      recibeReporteDiario: false,
      recibeTickets: false,
      recibeNotificacionPagos: true,
    });

    const customer = await adminPool.query<{ id: string }>(
      `INSERT INTO customers (external_id) VALUES ('3050000099') RETURNING id`,
    );
    customerId2 = customer.rows[0]!.id;
    const conversation = await adminPool.query<{ id: string }>(
      `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
      [customerId2],
    );
    conversationId2 = conversation.rows[0]!.id;
    const quote = await adminPool.query<{ id: string }>(
      `INSERT INTO quotes (conversation_id, customer_id, subtotal, total) VALUES ($1, $2, 1000, 1000) RETURNING id`,
      [conversationId2, customerId2],
    );
    quoteId2 = quote.rows[0]!.id;
    const order = await adminPool.query<{ id: string }>(
      `INSERT INTO orders (quote_id, conversation_id, customer_id, status, payment_method, payment_status, delivery_method, idempotency_key, total, wompi_payment_link_id)
       VALUES ($1, $2, $3, 'abierto', 'pago_en_linea', 'pendiente', 'domicilio', $4, 1000, $5)
       RETURNING id`,
      [quoteId2, conversationId2, customerId2, `idem-wompi-webhook-admins-${Date.now()}`, PAYMENT_LINK_ID_2],
    );
    orderId2 = order.rows[0]!.id;
    await adminPool.query(`INSERT INTO wompi_payment_links (payment_link_id, order_id) VALUES ($1, $2)`, [
      PAYMENT_LINK_ID_2,
      orderId2,
    ]);
  });

  afterEach(() => {
    vi.mocked(sendWhatsAppMessage).mockReset();
  });

  afterAll(async () => {
    await adminPool.query(`DELETE FROM admin_permissions WHERE admin_id = $1`, [adminId]);
    await adminPool.query(`DELETE FROM admins WHERE id = $1`, [adminId]);
    await adminPool.query(`DELETE FROM wompi_payment_links WHERE order_id = $1`, [orderId2]);
    await adminPool.query(`DELETE FROM orders WHERE id = $1`, [orderId2]);
    await adminPool.query(`DELETE FROM quotes WHERE id = $1`, [quoteId2]);
    await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationId2]);
    await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerId2]);
  });

  it("notifica al teléfono del admin con recibeNotificacionPagos, no al report_recipient_phone legado", async () => {
    const event = buildEvent("tx-approved-admin-1", "APPROVED", PAYMENT_LINK_ID_2);
    const response = await post(event);

    expect(response.statusCode).toBe(200);
    // Un admin con el permiso existe → gana sobre report_recipient_phone
    // (ver resolveNotificationRecipients: "solo si nadie más lo recibiría").
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      "whatsapp:+573000000098",
      expect.stringContaining(orderId2),
    );
    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(
      "whatsapp:+573000000002",
      expect.anything(),
    );
  });
});
