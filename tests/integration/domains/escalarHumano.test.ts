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

let conversationA: string;
let customerAId: string;

beforeAll(async () => {
  const customerA = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (phone_number) VALUES ('3010000001') RETURNING id`,
  );
  customerAId = customerA.rows[0]!.id;
  const conversationARes = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerAId],
  );
  conversationA = conversationARes.rows[0]!.id;
});

afterEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
});

afterAll(async () => {
  // Los human_agents/handoff_tokens creados dentro de cada it() ya se
  // borran ahí mismo — esto solo cubre handoff_queue (creado en casi
  // todos los tests) y la conversación/cliente semilla.
  await adminPool.query(
    `DELETE FROM handoff_tokens WHERE handoff_id IN (SELECT id FROM handoff_queue WHERE conversation_id = $1)`,
    [conversationA],
  );
  await adminPool.query(`DELETE FROM handoff_queue WHERE conversation_id = $1`, [conversationA]);
  await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationA]);
  await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerAId]);
  await adminPool.end();
  await appPool.end();
});

describe("escalarHumano", () => {
  it("crea un registro en handoff_queue con status queued y sin asesor asignado", async () => {
    const result = await escalarHumano(conversationA, {
      reason: "queja",
      summary: "El cliente está molesto por un retraso en su pedido.",
    });

    expect(result.status).toBe("queued");
    expect(result.assigned_to).toBeNull();
    expect(result.handoff_id).toBeTruthy();

    const row = await adminPool.query(`SELECT reason, summary FROM handoff_queue WHERE id = $1`, [
      result.handoff_id,
    ]);
    expect(row.rows[0]).toMatchObject({
      reason: "queja",
      summary: "El cliente está molesto por un retraso en su pedido.",
    });
  });

  it("falla si la conversación no existe (FK)", async () => {
    await expect(
      escalarHumano("00000000-0000-0000-0000-000000000000", {
        reason: "queja",
        summary: "x",
      }),
    ).rejects.toThrow();
  });

  it("notifica por WhatsApp al asesor activo, con un enlace a la vista del asesor", async () => {
    const agent = await adminPool.query<{ id: string }>(
      `INSERT INTO human_agents (name, contact, active) VALUES ('Asesor Test', 'whatsapp:+573009999999', true) RETURNING id`,
    );

    const result = await escalarHumano(conversationA, {
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
      escalarHumano(conversationA, { reason: "queja", summary: "sin asesores" }),
    ).resolves.toMatchObject({ status: "queued" });
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("el registro se crea igual aunque falle el envío de la notificación (best-effort)", async () => {
    const agent = await adminPool.query<{ id: string }>(
      `INSERT INTO human_agents (name, contact, active) VALUES ('Asesor Test 2', 'whatsapp:+573008888888', true) RETURNING id`,
    );
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("Twilio no disponible"));

    const result = await escalarHumano(conversationA, {
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
