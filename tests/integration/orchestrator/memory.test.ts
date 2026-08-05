import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { resolveConversation } from "../../../src/orchestrator/memory.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const PHONES = [
  "whatsapp:+573000000100",
  "whatsapp:+573000000101",
  "whatsapp:+573000000102",
  "whatsapp:+573000000103",
];

afterAll(async () => {
  await adminPool.query(
    `DELETE FROM conversations WHERE customer_id IN (SELECT id FROM customers WHERE phone_number = ANY($1))`,
    [PHONES],
  );
  await adminPool.query(`DELETE FROM customers WHERE phone_number = ANY($1)`, [PHONES]);
  await adminPool.end();
  await appPool.end();
});

describe("resolveConversation — captura de ProfileName", () => {
  it("guarda el nombre en el primer mensaje del cliente", async () => {
    await resolveConversation("whatsapp:+573000000100", "Camila Pérez");
    const result = await adminPool.query<{ name: string | null }>(
      `SELECT name FROM customers WHERE phone_number = $1`,
      ["whatsapp:+573000000100"],
    );
    expect(result.rows[0]!.name).toBe("Camila Pérez");
  });

  it("conserva el nombre ya guardado si un mensaje posterior llega sin ProfileName", async () => {
    await resolveConversation("whatsapp:+573000000101", "Julián Gómez");
    await resolveConversation("whatsapp:+573000000101", undefined);
    const result = await adminPool.query<{ name: string | null }>(
      `SELECT name FROM customers WHERE phone_number = $1`,
      ["whatsapp:+573000000101"],
    );
    expect(result.rows[0]!.name).toBe("Julián Gómez");
  });

  it("actualiza el nombre si el cliente cambia su nombre de perfil de WhatsApp", async () => {
    await resolveConversation("whatsapp:+573000000102", "Nombre Viejo");
    await resolveConversation("whatsapp:+573000000102", "Nombre Nuevo");
    const result = await adminPool.query<{ name: string | null }>(
      `SELECT name FROM customers WHERE phone_number = $1`,
      ["whatsapp:+573000000102"],
    );
    expect(result.rows[0]!.name).toBe("Nombre Nuevo");
  });

  it("sin ProfileName en ningún mensaje, el nombre queda null", async () => {
    await resolveConversation("whatsapp:+573000000103");
    const result = await adminPool.query<{ name: string | null }>(
      `SELECT name FROM customers WHERE phone_number = $1`,
      ["whatsapp:+573000000103"],
    );
    expect(result.rows[0]!.name).toBeNull();
  });
});

describe("resolveConversation — conversationBotPaused (Fase 18)", () => {
  const PHONE = "whatsapp:+573000000104";

  afterAll(async () => {
    await adminPool.query(
      `DELETE FROM conversations WHERE customer_id IN (SELECT id FROM customers WHERE phone_number = $1)`,
      [PHONE],
    );
    await adminPool.query(`DELETE FROM customers WHERE phone_number = $1`, [PHONE]);
  });

  it("devuelve conversationBotPaused: true para una conversación pausada puntualmente", async () => {
    const first = await resolveConversation(PHONE, "Cliente Pausado");
    expect(first.conversationBotPaused).toBe(false);

    await adminPool.query(`UPDATE conversations SET bot_paused = true WHERE id = $1`, [
      first.conversationId,
    ]);

    const second = await resolveConversation(PHONE);
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.conversationBotPaused).toBe(true);
  });
});
