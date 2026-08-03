import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdmin } from "../../../src/admin/auth/adminsDirectory.js";
import { hashPassword } from "../../../src/admin/auth/passwordHash.js";
import { buildDailyReportText } from "../../../src/jobs/dailyReport.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let tenantId: string;
let tenantSinReporte: string;
let tenantConAdminMaster: string;
let convCerradaId: string;

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

  const tenant = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name, report_recipient_phone)
     VALUES ('Reporte Diario Test', 'whatsapp:+573009999999') RETURNING id`,
  );
  tenantId = tenant.rows[0]!.id;

  const tenantSin = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Reporte Diario Test Sin Config') RETURNING id`,
  );
  tenantSinReporte = tenantSin.rows[0]!.id;

  // Fase 13 (ver ADR-025): sin report_recipient_phone legado, pero con un
  // admin master (permiso recibeReporteDiario implícito) y teléfono
  // cargado — buildDailyReportText debe dejar de depender solo del campo
  // legado del tenant.
  const tenantAdmin = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Reporte Diario Test Con Admin') RETURNING id`,
  );
  tenantConAdminMaster = tenantAdmin.rows[0]!.id;
  const passwordHash = await hashPassword("clave-de-prueba-reporte");
  await createAdmin(
    tenantConAdminMaster,
    "master-reporte@formotos-test.com",
    passwordHash,
    "master",
    "whatsapp:+573000000097",
  );

  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, phone_number) VALUES ($1, 'whatsapp:+573001112222') RETURNING id`,
    [tenantId],
  );
  const customerId = customer.rows[0]!.id;

  // Conversación cerrada AYER, sin escalar.
  const convCerrada = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, customer_id, status, closed_at)
     VALUES ($1, $2, 'closed', $3) RETURNING id`,
    [tenantId, customerId, ayerMedio],
  );
  convCerradaId = convCerrada.rows[0]!.id;

  // Conversación cerrada AYER, escalada.
  const convEscalada = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, customer_id, status, closed_at)
     VALUES ($1, $2, 'closed', $3) RETURNING id`,
    [tenantId, customerId, ayerMedio],
  );
  await adminPool.query(
    `INSERT INTO handoff_queue (tenant_id, conversation_id, reason, status, summary)
     VALUES ($1, $2, 'solicitud_cliente', 'resuelto', 'test')`,
    [tenantId, convEscalada.rows[0]!.id],
  );

  // Conversación cerrada HOY — no debe contar en el reporte de "ayer".
  await adminPool.query(
    `INSERT INTO conversations (tenant_id, customer_id, status, closed_at) VALUES ($1, $2, 'closed', $3)`,
    [tenantId, customerId, hoyMedio],
  );

  // Mensajes: 2 de ayer (sí cuentan), 1 de hoy y 1 de anteayer (no deben contar).
  await adminPool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content, created_at)
     VALUES ($1, $2, 'inbound', 'customer', 'hola', $3), ($1, $2, 'outbound', 'agent', 'hola!', $3)`,
    [tenantId, convCerradaId, ayerMedio],
  );
  await adminPool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content, created_at)
     VALUES ($1, $2, 'inbound', 'customer', 'mensaje de hoy', $3)`,
    [tenantId, convCerradaId, hoyMedio],
  );
  await adminPool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content, created_at)
     VALUES ($1, $2, 'inbound', 'customer', 'mensaje de anteayer', $3)`,
    [tenantId, convCerradaId, anteayer],
  );

  // Pedido confirmado AYER — quotes solo por la FK de orders, sin quote_items
  // (el reporte no los necesita).
  const quote = await adminPool.query<{ id: string }>(
    `INSERT INTO quotes (tenant_id, conversation_id, customer_id, subtotal, total)
     VALUES ($1, $2, $3, 50000, 50000) RETURNING id`,
    [tenantId, convCerradaId, customerId],
  );
  await adminPool.query(
    `INSERT INTO orders
       (tenant_id, quote_id, conversation_id, customer_id, payment_method, delivery_method, idempotency_key, total, created_at)
     VALUES ($1, $2, $3, $4, 'transferencia', 'domicilio', 'reporte-diario-test-key', 50000, $5)`,
    [tenantId, quote.rows[0]!.id, convCerradaId, customerId, ayerMedio],
  );
});

afterAll(async () => {
  const tenants = [tenantId, tenantSinReporte, tenantConAdminMaster];
  await adminPool.query(`DELETE FROM orders WHERE tenant_id = ANY($1)`, [tenants]);
  await adminPool.query(`DELETE FROM quotes WHERE tenant_id = ANY($1)`, [tenants]);
  await adminPool.query(`DELETE FROM handoff_queue WHERE tenant_id = ANY($1)`, [tenants]);
  await adminPool.query(`DELETE FROM messages WHERE tenant_id = ANY($1)`, [tenants]);
  await adminPool.query(`DELETE FROM conversations WHERE tenant_id = ANY($1)`, [tenants]);
  await adminPool.query(`DELETE FROM customers WHERE tenant_id = ANY($1)`, [tenants]);
  await adminPool.query(`DELETE FROM admin_permissions WHERE tenant_id = ANY($1)`, [tenants]);
  await adminPool.query(`DELETE FROM admins WHERE tenant_id = ANY($1)`, [tenants]);
  await adminPool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenants]);
  await adminPool.end();
  await appPool.end();
});

describe("buildDailyReportText", () => {
  it("resume solo lo de ayer (hora Bogotá): mensajes, conversaciones cerradas/escaladas y pedidos", async () => {
    const text = await buildDailyReportText(tenantId);

    expect(text).not.toBeNull();
    expect(text).toContain("Mensajes: 2");
    expect(text).toContain("Clientes únicos: 1");
    expect(text).toContain("Conversaciones cerradas: 2 (1 sin escalar)");
    expect(text).toContain("Pedidos confirmados: 1");
    expect(text).toContain("50.000");
  });

  it("tenant sin report_recipient_phone configurado devuelve null, no un texto vacío", async () => {
    const text = await buildDailyReportText(tenantSinReporte);
    expect(text).toBeNull();
  });

  it("tenant con admin master (Fase 13) recibe reporte aunque no tenga report_recipient_phone legado", async () => {
    const text = await buildDailyReportText(tenantConAdminMaster);
    expect(text).not.toBeNull();
    expect(text).toContain("Mensajes: 0");
  });

  it("tenant inexistente devuelve null", async () => {
    const text = await buildDailyReportText("00000000-0000-0000-0000-000000000000");
    expect(text).toBeNull();
  });
});
