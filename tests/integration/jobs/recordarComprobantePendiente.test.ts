import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendToConversation: vi.fn(),
  getWhatsAppMessageStatus: vi.fn(),
}));

import { createAdmin } from "../../../src/admin/auth/adminsDirectory.js";
import { hashPassword } from "../../../src/admin/auth/passwordHash.js";
import { sendToConversation } from "../../../src/gateway/sendMessage.js";
import { runRecordarComprobantePendiente } from "../../../src/jobs/recordarComprobantePendiente.js";
import {
  invalidateConnectionsCache,
  saveConnection,
} from "../../../src/shared/db/connectionsDirectory.js";
import { saveTransferAccounts, type TransferAccount } from "../../../src/shared/db/settingsDirectory.js";
import { createTemplateRecord } from "../../../src/shared/db/whatsappTemplatesDirectory.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const fetchMock = vi.fn();

const CUENTA: TransferAccount = {
  entity: "Bancolombia",
  accountType: "Ahorros",
  accountNumber: "111-222333-44",
  holderName: "ForMotos SAS",
  holderDocument: "",
  active: true,
};

const PHONES = {
  reciente: "whatsapp:+573040000001",
  friaConPlantilla: "whatsapp:+573040000002",
  friaSinPlantilla: "whatsapp:+573040000003",
  escalado: "whatsapp:+573040000004",
  aprobado: "whatsapp:+573040000005",
  yaRecordado: "whatsapp:+573040000006",
  muyNuevo: "whatsapp:+573040000007",
  muyViejo: "whatsapp:+573040000008",
};

interface Setup {
  orderId: string;
  conversationId: string;
  publicOrderNumber: string;
}

const setups: Record<keyof typeof PHONES, Setup> = {} as never;

let settingsId: string;
let connectionId: string;
let connectionIdSinPlantilla: string;
let adminId: string;

async function seedOrder(
  key: keyof typeof PHONES,
  opts: {
    ageHours: number;
    lastInboundHoursAgo: number | null;
    paymentStatus?: string;
    reminderAlreadySent?: boolean;
    lastReceiptResultado?: string;
    connectionIdOverride?: string;
  },
): Promise<Setup> {
  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id) VALUES ($1) RETURNING id`,
    [PHONES[key]],
  );
  const customerId = customer.rows[0]!.id;

  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id, connection_id, channel) VALUES ($1, $2, 'whatsapp') RETURNING id`,
    [customerId, opts.connectionIdOverride ?? connectionId],
  );
  const conversationId = conversation.rows[0]!.id;

  if (opts.lastInboundHoursAgo !== null) {
    await adminPool.query(
      `INSERT INTO messages (conversation_id, direction, sender_type, content, created_at)
       VALUES ($1, 'inbound', 'customer', 'hola', now() - ($2 || ' hours')::interval)`,
      [conversationId, opts.lastInboundHoursAgo],
    );
  }

  const quote = await adminPool.query<{ id: string }>(
    `INSERT INTO quotes (conversation_id, customer_id, subtotal, total) VALUES ($1, $2, 50000, 50000) RETURNING id`,
    [conversationId, customerId],
  );

  const order = await adminPool.query<{ id: string; public_order_number: string }>(
    `INSERT INTO orders (quote_id, conversation_id, customer_id, status, payment_method, payment_status, delivery_method, idempotency_key, total, created_at, comprobante_reminder_sent_at)
     VALUES ($1, $2, $3, 'abierto', 'transferencia', $4, 'recoger_en_tienda', $5, 50000, now() - ($6 || ' hours')::interval, $7)
     RETURNING id, public_order_number`,
    [
      quote.rows[0]!.id,
      conversationId,
      customerId,
      opts.paymentStatus ?? "pendiente",
      `comprobante-reminder-test-${key}`,
      opts.ageHours,
      opts.reminderAlreadySent ? new Date() : null,
    ],
  );
  const orderId = order.rows[0]!.id;

  if (opts.lastReceiptResultado) {
    const media = await adminPool.query<{ id: string }>(
      `INSERT INTO inbound_media (conversation_id, kind, mime_type, data_base64) VALUES ($1, 'image', 'image/jpeg', '') RETURNING id`,
      [conversationId],
    );
    await adminPool.query(
      `INSERT INTO payment_receipts (order_id, inbound_media_id, ocr_monto, ocr_cuenta, resultado) VALUES ($1, $2, NULL, NULL, $3)`,
      [orderId, media.rows[0]!.id, opts.lastReceiptResultado],
    );
  }

  return { orderId, conversationId, publicOrderNumber: order.rows[0]!.public_order_number };
}

beforeAll(async () => {
  const settings = await adminPool.query<{ id: string }>(
    `INSERT INTO settings (name) VALUES ('Recordatorio Comprobante Test') RETURNING id`,
  );
  settingsId = settings.rows[0]!.id;
  await saveTransferAccounts([CUENTA]);

  connectionId = await saveConnection({
    channel: "whatsapp",
    provider: "meta",
    label: "WhatsApp Recordatorio Comprobante Test · Meta",
    externalId: "555666777888999",
    displayAddress: "+57 300 444 5555",
    credentials: {
      phoneNumberId: "555666777888999",
      wabaId: "waba-recordatorio-test",
      accessToken: "token-recordatorio-test",
      appSecret: "secreto-recordatorio-test",
      verifyToken: "verify-recordatorio-test",
    },
  });
  // Conexión separada, deliberadamente sin ninguna plantilla aprobada —
  // así "friaSinPlantilla" prueba el no-op sin compartir la plantilla que
  // sí tiene "friaConPlantilla" (misma conexión = mismo resultado de
  // resolveApprovedTemplate para las dos).
  connectionIdSinPlantilla = await saveConnection({
    channel: "whatsapp",
    provider: "meta",
    label: "WhatsApp Recordatorio Comprobante Test Sin Plantilla · Meta",
    externalId: "555666777889000",
    displayAddress: "+57 300 444 5556",
    credentials: {
      phoneNumberId: "555666777889000",
      wabaId: "waba-recordatorio-test-2",
      accessToken: "token-recordatorio-test-2",
      appSecret: "secreto-recordatorio-test-2",
      verifyToken: "verify-recordatorio-test-2",
    },
  });

  const passwordHash = await hashPassword("clave-de-prueba-recordatorio-comprobante");
  adminId = await createAdmin(
    "admin-recordatorio-comprobante",
    "recordatorio-comprobante@formotos.test",
    passwordHash,
    "master",
    null,
  );

  setups.reciente = await seedOrder("reciente", { ageHours: 5, lastInboundHoursAgo: 2 });
  setups.friaConPlantilla = await seedOrder("friaConPlantilla", { ageHours: 30, lastInboundHoursAgo: null });
  setups.friaSinPlantilla = await seedOrder("friaSinPlantilla", {
    ageHours: 30,
    lastInboundHoursAgo: null,
    connectionIdOverride: connectionIdSinPlantilla,
  });
  setups.escalado = await seedOrder("escalado", {
    ageHours: 5,
    lastInboundHoursAgo: 2,
    lastReceiptResultado: "pendiente_revision",
  });
  setups.aprobado = await seedOrder("aprobado", {
    ageHours: 5,
    lastInboundHoursAgo: 2,
    paymentStatus: "pagado",
  });
  setups.yaRecordado = await seedOrder("yaRecordado", {
    ageHours: 5,
    lastInboundHoursAgo: 2,
    reminderAlreadySent: true,
  });
  setups.muyNuevo = await seedOrder("muyNuevo", { ageHours: 1, lastInboundHoursAgo: 0.5 });
  setups.muyViejo = await seedOrder("muyViejo", { ageHours: 24 * 8, lastInboundHoursAgo: null });

  // La plantilla solo se crea para "friaConPlantilla" — "friaSinPlantilla"
  // deliberadamente no tiene ninguna aprobada, para probar el no-op.
  await createTemplateRecord({
    connectionId,
    name: "recordatorio_comprobante",
    category: "UTILITY",
    language: "es",
    components: [
      { type: "BODY", text: "Hola {{1}}, todavía no nos llegó el comprobante de tu pedido #{{2}} por {{3}}." },
    ],
    createdByAdminId: adminId,
  }).then((id) => adminPool.query(`UPDATE whatsapp_templates SET status = 'approved' WHERE id = $1`, [id]));
});

afterEach(() => {
  vi.mocked(sendToConversation).mockReset();
  fetchMock.mockReset();
});

afterAll(async () => {
  const phones = Object.values(PHONES);
  await adminPool.query(
    `DELETE FROM payment_receipts WHERE order_id IN (SELECT id FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE external_id = ANY($1)))`,
    [phones],
  );
  await adminPool.query(
    `DELETE FROM inbound_media WHERE conversation_id IN (SELECT c.id FROM conversations c JOIN customers cu ON cu.id = c.customer_id WHERE cu.external_id = ANY($1))`,
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
  await adminPool.query(`DELETE FROM channel_connections WHERE id = ANY($1)`, [
    [connectionId, connectionIdSinPlantilla],
  ]);
  invalidateConnectionsCache();
  await adminPool.query(`DELETE FROM settings WHERE id = $1`, [settingsId]);
  await adminPool.query(`DELETE FROM admin_permissions WHERE admin_id = $1`, [adminId]);
  await adminPool.query(`DELETE FROM admins WHERE id = $1`, [adminId]);
  await adminPool.end();
  await appPool.end();
});

describe("runRecordarComprobantePendiente", () => {
  it("pedido reciente (mensaje inbound < 24h) -> texto libre con los datos de transferencia", async () => {
    vi.mocked(sendToConversation).mockResolvedValue("SM_TEST_SID");
    vi.stubGlobal("fetch", fetchMock);

    await runRecordarComprobantePendiente();

    expect(sendToConversation).toHaveBeenCalledWith(
      setups.reciente.conversationId,
      expect.stringContaining(setups.reciente.publicOrderNumber),
    );
    const [, texto] = vi.mocked(sendToConversation).mock.calls.find(
      (call) => call[0] === setups.reciente.conversationId,
    )!;
    expect(texto).toContain("111-222333-44");

    const row = await adminPool.query<{ comprobante_reminder_sent_at: Date | null }>(
      `SELECT comprobante_reminder_sent_at FROM orders WHERE id = $1`,
      [setups.reciente.orderId],
    );
    expect(row.rows[0]!.comprobante_reminder_sent_at).not.toBeNull();

    vi.unstubAllGlobals();
  });

  it("pedido frío (sin mensaje inbound reciente) con plantilla aprobada -> manda la plantilla y marca el recordatorio", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.recordatorio" }] }) });
    vi.stubGlobal("fetch", fetchMock);

    await runRecordarComprobantePendiente();

    expect(fetchMock).toHaveBeenCalled();
    const row = await adminPool.query<{ comprobante_reminder_sent_at: Date | null }>(
      `SELECT comprobante_reminder_sent_at FROM orders WHERE id = $1`,
      [setups.friaConPlantilla.orderId],
    );
    expect(row.rows[0]!.comprobante_reminder_sent_at).not.toBeNull();

    vi.unstubAllGlobals();
  });

  it("pedido frío sin plantilla aprobada -> no-op, no marca el recordatorio", async () => {
    const row = await adminPool.query<{ comprobante_reminder_sent_at: Date | null }>(
      `SELECT comprobante_reminder_sent_at FROM orders WHERE id = $1`,
      [setups.friaSinPlantilla.orderId],
    );
    expect(row.rows[0]!.comprobante_reminder_sent_at).toBeNull();
  });

  it("no toca pedidos escalados, aprobados, ya recordados, muy nuevos o muy viejos", async () => {
    const ids = [
      setups.escalado.orderId,
      setups.aprobado.orderId,
      setups.muyNuevo.orderId,
      setups.muyViejo.orderId,
    ];
    for (const id of ids) {
      expect(sendToConversation).not.toHaveBeenCalledWith(
        (await adminPool.query(`SELECT conversation_id FROM orders WHERE id = $1`, [id])).rows[0]!.conversation_id,
        expect.any(String),
      );
    }
    // yaRecordado: ya tenía el flag antes de correr el job, sigue igual (no se reenvía).
    const row = await adminPool.query<{ comprobante_reminder_sent_at: Date }>(
      `SELECT comprobante_reminder_sent_at FROM orders WHERE id = $1`,
      [setups.yaRecordado.orderId],
    );
    expect(row.rows[0]!.comprobante_reminder_sent_at).not.toBeNull();
  });
});
