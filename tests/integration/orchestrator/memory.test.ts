import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { resolveConversation } from "../../../src/orchestrator/memory.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let tenantId: string;

beforeAll(async () => {
  const tenant = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Memory Test Tenant') RETURNING id`,
  );
  tenantId = tenant.rows[0]!.id;
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM conversations WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM customers WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  await adminPool.end();
  await appPool.end();
});

describe("resolveConversation — captura de ProfileName", () => {
  it("guarda el nombre en el primer mensaje del cliente", async () => {
    await resolveConversation(tenantId, "whatsapp:+573000000100", "Camila Pérez");
    const result = await adminPool.query<{ name: string | null }>(
      `SELECT name FROM customers WHERE tenant_id = $1 AND phone_number = $2`,
      [tenantId, "whatsapp:+573000000100"],
    );
    expect(result.rows[0]!.name).toBe("Camila Pérez");
  });

  it("conserva el nombre ya guardado si un mensaje posterior llega sin ProfileName", async () => {
    await resolveConversation(tenantId, "whatsapp:+573000000101", "Julián Gómez");
    await resolveConversation(tenantId, "whatsapp:+573000000101", undefined);
    const result = await adminPool.query<{ name: string | null }>(
      `SELECT name FROM customers WHERE tenant_id = $1 AND phone_number = $2`,
      [tenantId, "whatsapp:+573000000101"],
    );
    expect(result.rows[0]!.name).toBe("Julián Gómez");
  });

  it("actualiza el nombre si el cliente cambia su nombre de perfil de WhatsApp", async () => {
    await resolveConversation(tenantId, "whatsapp:+573000000102", "Nombre Viejo");
    await resolveConversation(tenantId, "whatsapp:+573000000102", "Nombre Nuevo");
    const result = await adminPool.query<{ name: string | null }>(
      `SELECT name FROM customers WHERE tenant_id = $1 AND phone_number = $2`,
      [tenantId, "whatsapp:+573000000102"],
    );
    expect(result.rows[0]!.name).toBe("Nombre Nuevo");
  });

  it("sin ProfileName en ningún mensaje, el nombre queda null", async () => {
    await resolveConversation(tenantId, "whatsapp:+573000000103");
    const result = await adminPool.query<{ name: string | null }>(
      `SELECT name FROM customers WHERE tenant_id = $1 AND phone_number = $2`,
      [tenantId, "whatsapp:+573000000103"],
    );
    expect(result.rows[0]!.name).toBeNull();
  });
});
