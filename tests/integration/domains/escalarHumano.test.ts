import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
}));

import { sendWhatsAppMessage } from "../../../src/gateway/sendMessage.js";
import { escalarHumano } from "../../../src/domains/escalation/escalarHumano.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let tenantA: string;
let tenantB: string;
let conversationA: string;

beforeAll(async () => {
  const a = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Escalar Humano Test A') RETURNING id`,
  );
  tenantA = a.rows[0]!.id;
  const b = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Escalar Humano Test B') RETURNING id`,
  );
  tenantB = b.rows[0]!.id;

  const customerA = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, phone_number) VALUES ($1, '3010000001') RETURNING id`,
    [tenantA],
  );
  const conversationARes = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id`,
    [tenantA, customerA.rows[0]!.id],
  );
  conversationA = conversationARes.rows[0]!.id;
});

afterEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM handoff_tokens WHERE tenant_id IN ($1, $2)`, [
    tenantA,
    tenantB,
  ]);
  await adminPool.query(`DELETE FROM handoff_queue WHERE tenant_id IN ($1, $2)`, [
    tenantA,
    tenantB,
  ]);
  await adminPool.query(`DELETE FROM human_agents WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM conversations WHERE tenant_id IN ($1, $2)`, [
    tenantA,
    tenantB,
  ]);
  await adminPool.query(`DELETE FROM customers WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.end();
  await appPool.end();
});

describe("escalarHumano", () => {
  it("crea un registro en handoff_queue con status queued y sin asesor asignado", async () => {
    const result = await escalarHumano(tenantA, conversationA, {
      reason: "queja",
      summary: "El cliente está molesto por un retraso en su pedido.",
    });

    expect(result.status).toBe("queued");
    expect(result.assigned_to).toBeNull();
    expect(result.handoff_id).toBeTruthy();

    const row = await adminPool.query(
      `SELECT reason, summary, tenant_id FROM handoff_queue WHERE id = $1`,
      [result.handoff_id],
    );
    expect(row.rows[0]).toMatchObject({
      reason: "queja",
      summary: "El cliente está molesto por un retraso en su pedido.",
      tenant_id: tenantA,
    });
  });

  it("el registro queda aislado por RLS: tenant_b no lo ve consultando con su propia sesión", async () => {
    const result = await escalarHumano(tenantA, conversationA, {
      reason: "solicitud_cliente",
      summary: "El cliente pidió hablar con una persona.",
    });

    const { withTenant } = await import("../../../src/shared/db/withTenant.js");
    const seenFromTenantB = await withTenant(tenantB, (client) =>
      client.query(`SELECT * FROM handoff_queue WHERE id = $1`, [result.handoff_id]),
    );
    expect(seenFromTenantB.rows).toHaveLength(0);
  });

  it("falla si la conversación no existe (FK)", async () => {
    await expect(
      escalarHumano(tenantA, "00000000-0000-0000-0000-000000000000", {
        reason: "queja",
        summary: "x",
      }),
    ).rejects.toThrow();
  });

  it("notifica por WhatsApp al asesor activo del tenant, con un enlace a la vista del asesor", async () => {
    const agent = await adminPool.query<{ id: string }>(
      `INSERT INTO human_agents (tenant_id, name, contact, active) VALUES ($1, 'Asesor Test', 'whatsapp:+573009999999', true) RETURNING id`,
      [tenantA],
    );

    const result = await escalarHumano(tenantA, conversationA, {
      reason: "monto_alto",
      summary: "Cotización grande.",
    });

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      "whatsapp:+573009999999",
      expect.stringMatching(/monto_alto[\s\S]*\/asesor\//),
    );

    const token = await adminPool.query<{ human_agent_id: string }>(
      `SELECT human_agent_id FROM handoff_tokens WHERE handoff_id = $1`,
      [result.handoff_id],
    );
    expect(token.rows[0]!.human_agent_id).toBe(agent.rows[0]!.id);

    await adminPool.query(`DELETE FROM handoff_tokens WHERE human_agent_id = $1`, [
      agent.rows[0]!.id,
    ]);
    await adminPool.query(`DELETE FROM human_agents WHERE id = $1`, [agent.rows[0]!.id]);
  });

  it("no falla si no hay ningún asesor activo (no intenta notificar)", async () => {
    await expect(
      escalarHumano(tenantA, conversationA, { reason: "queja", summary: "sin asesores" }),
    ).resolves.toMatchObject({ status: "queued" });
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("el registro se crea igual aunque falle el envío de la notificación (best-effort)", async () => {
    const agent = await adminPool.query<{ id: string }>(
      `INSERT INTO human_agents (tenant_id, name, contact, active) VALUES ($1, 'Asesor Test 2', 'whatsapp:+573008888888', true) RETURNING id`,
      [tenantA],
    );
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("Twilio no disponible"));

    const result = await escalarHumano(tenantA, conversationA, {
      reason: "queja",
      summary: "notificación que va a fallar",
    });

    expect(result.status).toBe("queued");

    await adminPool.query(`DELETE FROM handoff_tokens WHERE human_agent_id = $1`, [
      agent.rows[0]!.id,
    ]);
    await adminPool.query(`DELETE FROM human_agents WHERE id = $1`, [agent.rows[0]!.id]);
  });
});
