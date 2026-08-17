import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAdmin } from "../../../src/admin/auth/adminsDirectory.js";
import { hashPassword } from "../../../src/admin/auth/passwordHash.js";
import { buildDailyReportText } from "../../../src/jobs/dailyReport.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const REPORT_RECIPIENT = "whatsapp:+573009999999";
let settingsId: string;
let customerId: string;

beforeAll(async () => {
  // Límites reales de "ayer" en calendario de Bogotá — se calculan con la
  // misma expresión SQL que usa buildDailyReportText, para que el test no
  // dependa de asumir el offset fijo a mano ni sea flaky cerca de
  // medianoche.
  const bounds = await adminPool.query<{ desde: Date; hasta: Date }>(
    `SELECT
       (date_trunc('day', now() AT TIME ZONE 'America/Bogota') - interval '1 day') AT TIME ZONE 'America/Bogota' AS desde,
       date_trunc('day', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota' AS hasta`,
  );
  const { desde, hasta } = bounds.rows[0]!;
  const ayerMedio = new Date((desde.getTime() + hasta.getTime()) / 2);
  const hoyMedio = new Date(hasta.getTime() + 60 * 60 * 1000);
  const anteayer = new Date(desde.getTime() - 60 * 60 * 1000);

  const settings = await adminPool.query<{ id: string }>(
    `INSERT INTO settings (name, report_recipient_phone)
     VALUES ('Reporte Diario Test', $1) RETURNING id`,
    [REPORT_RECIPIENT],
  );
  settingsId = settings.rows[0]!.id;

  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (phone_number) VALUES ('whatsapp:+573001112222') RETURNING id`,
  );
  customerId = customer.rows[0]!.id;

  // Conversación cerrada AYER, sin escalar.
  const convCerrada = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id, status, closed_at)
     VALUES ($1, 'closed', $2) RETURNING id`,
    [customerId, ayerMedio],
  );
  const convCerradaId = convCerrada.rows[0]!.id;

  // Conversación cerrada AYER, escalada.
  const convEscalada = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id, status, closed_at)
     VALUES ($1, 'closed', $2) RETURNING id`,
    [customerId, ayerMedio],
  );
  await adminPool.query(
    `INSERT INTO handoff_queue (conversation_id, reason, status, summary)
     VALUES ($1, 'solicitud_cliente', 'resuelto', 'test')`,
    [convEscalada.rows[0]!.id],
  );

  // Conversación cerrada HOY — no debe contar en el reporte de "ayer".
  await adminPool.query(
    `INSERT INTO conversations (customer_id, status, closed_at) VALUES ($1, 'closed', $2)`,
    [customerId, hoyMedio],
  );

  // Mensajes: 2 de ayer (sí cuentan), 1 de hoy y 1 de anteayer (no deben contar).
  await adminPool.query(
    `INSERT INTO messages (conversation_id, direction, sender_type, content, created_at)
     VALUES ($1, 'inbound', 'customer', 'hola', $2), ($1, 'outbound', 'agent', 'hola!', $2)`,
    [convCerradaId, ayerMedio],
  );
  await adminPool.query(
    `INSERT INTO messages (conversation_id, direction, sender_type, content, created_at)
     VALUES ($1, 'inbound', 'customer', 'mensaje de hoy', $2)`,
    [convCerradaId, hoyMedio],
  );
  await adminPool.query(
    `INSERT INTO messages (conversation_id, direction, sender_type, content, created_at)
     VALUES ($1, 'inbound', 'customer', 'mensaje de anteayer', $2)`,
    [convCerradaId, anteayer],
  );

  // Pedido confirmado AYER — quote solo por la FK de orders, sin quote_items
  // (el reporte no los necesita).
  const quote = await adminPool.query<{ id: string }>(
    `INSERT INTO quotes (conversation_id, customer_id, subtotal, total)
     VALUES ($1, $2, 50000, 50000) RETURNING id`,
    [convCerradaId, customerId],
  );
  await adminPool.query(
    `INSERT INTO orders
       (quote_id, conversation_id, customer_id, payment_method, delivery_method, idempotency_key, total, created_at)
     VALUES ($1, $2, $3, 'transferencia', 'domicilio', 'reporte-diario-test-key', 50000, $4)`,
    [quote.rows[0]!.id, convCerradaId, customerId, ayerMedio],
  );
});

afterAll(async () => {
  await adminPool.query(
    `DELETE FROM orders WHERE customer_id = $1`,
    [customerId],
  );
  await adminPool.query(`DELETE FROM quotes WHERE customer_id = $1`, [customerId]);
  await adminPool.query(
    `DELETE FROM handoff_queue WHERE conversation_id IN (SELECT id FROM conversations WHERE customer_id = $1)`,
    [customerId],
  );
  await adminPool.query(
    `DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE customer_id = $1)`,
    [customerId],
  );
  await adminPool.query(`DELETE FROM conversations WHERE customer_id = $1`, [customerId]);
  await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  await adminPool.query(`DELETE FROM settings WHERE id = $1`, [settingsId]);
  await adminPool.end();
  await appPool.end();
});

describe("buildDailyReportText", () => {
  it("resume solo lo de ayer (hora Bogotá): mensajes, conversaciones cerradas/escaladas y pedidos", async () => {
    const text = await buildDailyReportText();

    expect(text).not.toBeNull();
    expect(text).toContain("Mensajes: 2");
    expect(text).toContain("Clientes únicos: 1");
    expect(text).toContain("Conversaciones cerradas: 2 (1 sin escalar)");
    expect(text).toContain("Pedidos confirmados: 1");
    expect(text).toContain("50.000");
  });

  describe("sin ningún destinatario configurado", () => {
    beforeEach(async () => {
      await adminPool.query(`UPDATE settings SET report_recipient_phone = NULL WHERE id = $1`, [
        settingsId,
      ]);
    });

    afterEach(async () => {
      await adminPool.query(`UPDATE settings SET report_recipient_phone = $1 WHERE id = $2`, [
        REPORT_RECIPIENT,
        settingsId,
      ]);
    });

    it("devuelve null, no un texto vacío", async () => {
      const text = await buildDailyReportText();
      expect(text).toBeNull();
    });
  });

  describe("con admin master (Fase 13)", () => {
    let adminId: string;

    beforeEach(async () => {
      // Sin report_recipient_phone legado, pero con un admin master
      // (permiso recibeReporteDiario implícito) y teléfono cargado —
      // buildDailyReportText debe dejar de depender solo del campo legado.
      await adminPool.query(`UPDATE settings SET report_recipient_phone = NULL WHERE id = $1`, [
        settingsId,
      ]);
      const passwordHash = await hashPassword("clave-de-prueba-reporte");
      adminId = await createAdmin(
        "master-reporte-test",
        "master-reporte@formotos-test.com",
        passwordHash,
        "master",
        "whatsapp:+573000000097",
      );
    });

    afterEach(async () => {
      await adminPool.query(`DELETE FROM admin_permissions WHERE admin_id = $1`, [adminId]);
      await adminPool.query(`DELETE FROM admins WHERE id = $1`, [adminId]);
      await adminPool.query(`UPDATE settings SET report_recipient_phone = $1 WHERE id = $2`, [
        REPORT_RECIPIENT,
        settingsId,
      ]);
    });

    it("recibe reporte aunque no tenga report_recipient_phone legado", async () => {
      const text = await buildDailyReportText();
      expect(text).not.toBeNull();
    });
  });
});
