import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  invalidateConnectionsCache,
  saveConnection,
} from "../../../src/shared/db/connectionsDirectory.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { resolveConversation } from "../../../src/orchestrator/memory.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const PHONES = [
  "whatsapp:+573000000100",
  "whatsapp:+573000000101",
  "whatsapp:+573000000102",
  "whatsapp:+573000000103",
  "whatsapp:+573000000104",
];

// Conexiones de mentira para el caso multicanal — se borran en afterAll.
const CONEXIONES_TEST = ["whatsapp:+570000000801", "test-meta-phone-id-0801"];

afterAll(async () => {
  await adminPool.query(
    `DELETE FROM conversations WHERE customer_id IN (SELECT id FROM customers WHERE phone_number = ANY($1))`,
    [PHONES],
  );
  await adminPool.query(`DELETE FROM customers WHERE phone_number = ANY($1)`, [PHONES]);
  await adminPool.query(`DELETE FROM channel_connections WHERE external_id = ANY($1)`, [
    CONEXIONES_TEST,
  ]);
  invalidateConnectionsCache();
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

describe("resolveConversation — la conversación sigue al último número usado (Fase 19, Etapa B)", () => {
  it("el mismo cliente por dos conexiones es UNA conversación, apuntando a la última", async () => {
    const twilio = await saveConnection({
      channel: "whatsapp",
      provider: "twilio",
      label: "Twilio memory test",
      externalId: CONEXIONES_TEST[0]!,
      displayAddress: CONEXIONES_TEST[0]!,
      credentials: { accountSid: "AC1", authToken: "t" },
    });
    const meta = await saveConnection({
      channel: "whatsapp",
      provider: "meta",
      label: "Meta memory test",
      externalId: CONEXIONES_TEST[1]!,
      displayAddress: "+57 300 000 0802",
      credentials: { phoneNumberId: CONEXIONES_TEST[1]!, accessToken: "t", appSecret: "s" },
    });

    const PHONE = "whatsapp:+573000000104";

    // Primero escribe al número de Twilio.
    const primera = await resolveConversation(PHONE, "Cliente Multicanal", {
      connectionId: twilio,
      channel: "whatsapp",
    });

    // Después, el mismo humano escribe al número de Meta.
    const segunda = await resolveConversation(PHONE, "Cliente Multicanal", {
      connectionId: meta,
      channel: "whatsapp",
    });

    // Un cliente, una conversación: conserva carrito, historial y pedido.
    expect(segunda.conversationId).toBe(primera.conversationId);

    // Pero la respuesta tiene que salir por donde escribió recién: sin esto
    // le contestaríamos desde un número que nunca contactó, lo que abre una
    // ventana de 24h nueva y el proveedor la rechaza.
    const fila = await adminPool.query<{ connection_id: string }>(
      `SELECT connection_id FROM conversations WHERE id = $1`,
      [primera.conversationId],
    );
    expect(fila.rows[0]!.connection_id).toBe(meta);

    // Y volver al primero la devuelve a Twilio.
    await resolveConversation(PHONE, undefined, { connectionId: twilio, channel: "whatsapp" });
    const devuelta = await adminPool.query<{ connection_id: string }>(
      `SELECT connection_id FROM conversations WHERE id = $1`,
      [primera.conversationId],
    );
    expect(devuelta.rows[0]!.connection_id).toBe(twilio);
  });
});
