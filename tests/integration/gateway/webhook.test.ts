import crypto from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../../src/config/env.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { redis } from "../../../src/shared/redis/client.js";
import { buildServer } from "../../../src/gateway/server.js";
import { INBOUND_STREAM } from "../../../src/gateway/queue.js";

const { Pool } = pg;

const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

function computeTwilioSignature(url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto
    .createHmac("sha1", env.twilioAuthToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");
}

// Sufijo único por corrida (no un número fijo): si un consumer real llega
// a levantar el mensaje encolado por estos tests (ej. un proceso de
// desarrollo dejado corriendo por error) y genera audit_log real para
// este tenant, el DELETE de abajo falla por el trigger de inmutabilidad
// (ver ADR-011/guardrails) — con un número fijo eso bloquea TODAS las
// corridas futuras por la constraint UNIQUE de whatsapp_number, no solo
// esta. Con sufijo único, un tenant "atascado" así queda inerte pero no
// vuelve a colisionar.
const TENANT_WHATSAPP_NUMBER = `whatsapp:+5730000${String(Date.now()).slice(-6)}`;
let tenantId: string;
const app = await buildServer();

beforeAll(async () => {
  const result = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name, whatsapp_number) VALUES ('Gateway Test Tenant', $1) RETURNING id`,
    [TENANT_WHATSAPP_NUMBER],
  );
  tenantId = result.rows[0]!.id;
  await app.ready();
});

afterAll(async () => {
  // Best-effort: si algo llegó a procesar los mensajes encolados por
  // estos tests (fuera del flujo normal, que solo verifica encolamiento)
  // y quedó audit_log real para este tenant, el DELETE final falla por
  // diseño (audit_log es inmutable) — no debe tumbar la suite por eso.
  await adminPool.query(`DELETE FROM messages WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM conversations WHERE tenant_id = $1`, [tenantId]);
  await adminPool.query(`DELETE FROM customers WHERE tenant_id = $1`, [tenantId]);
  try {
    await adminPool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  } catch {
    // Tenant queda inerte (ver comentario en TENANT_WHATSAPP_NUMBER) — no
    // se puede evitar sin violar la inmutabilidad de audit_log.
  }
  await redis.del(INBOUND_STREAM);
  await redis.del(
    "wa:processed:webhook-test-sid-1",
    "wa:processed:webhook-test-sid-2",
    "wa:processed:webhook-test-sid-ratelimit",
    "wa:processed:webhook-test-sid-profilename",
  );
  await app.close();
  await adminPool.end();
  await redis.quit();
  await appPool.end();
});

async function post(params: Record<string, string>, signature: string) {
  // app.inject() serializa cualquier payload que no sea string/Buffer como
  // JSON, sin importar el content-type que se le ponga — hay que
  // construir el string application/x-www-form-urlencoded a mano para que
  // @fastify/formbody lo parsee igual que un webhook real de Twilio.
  const body = new URLSearchParams(params).toString();
  return app.inject({
    method: "POST",
    url: "/webhooks/whatsapp",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    payload: body,
  });
}

describe("POST /webhooks/whatsapp", () => {
  it("mensaje válido con firma correcta se encola", async () => {
    const params = {
      MessageSid: "webhook-test-sid-1",
      From: "whatsapp:+573000000001",
      To: TENANT_WHATSAPP_NUMBER,
      Body: "Hola, tienen cascos?",
    };
    const signature = computeTwilioSignature(env.publicWebhookUrl, params);

    const response = await post(params, signature);
    expect(response.statusCode).toBe(200);

    const entries = await redis.xrange(INBOUND_STREAM, "-", "+");
    const match = entries.find(([, fields]: [string, string[]]) =>
      fields.includes("webhook-test-sid-1"),
    );
    expect(match).toBeDefined();
  });

  it("propaga ProfileName como customer_name en el mensaje encolado", async () => {
    const params = {
      MessageSid: "webhook-test-sid-profilename",
      From: "whatsapp:+573000000099",
      To: TENANT_WHATSAPP_NUMBER,
      Body: "Hola, tienen cascos?",
      ProfileName: "Camila Pérez",
    };
    const signature = computeTwilioSignature(env.publicWebhookUrl, params);

    const response = await post(params, signature);
    expect(response.statusCode).toBe(200);

    const entries = await redis.xrange(INBOUND_STREAM, "-", "+");
    const match = entries.find(([, fields]: [string, string[]]) =>
      fields.includes("webhook-test-sid-profilename"),
    );
    expect(match).toBeDefined();
    const fields = match![1];
    const nameIdx = fields.indexOf("customer_name");
    expect(fields[nameIdx + 1]).toBe("Camila Pérez");
  });

  it("el mismo MessageSid reenviado no se duplica en el stream", async () => {
    const params = {
      MessageSid: "webhook-test-sid-1",
      From: "whatsapp:+573000000001",
      To: TENANT_WHATSAPP_NUMBER,
      Body: "Hola, tienen cascos?",
    };
    const signature = computeTwilioSignature(env.publicWebhookUrl, params);

    const before = await redis.xlen(INBOUND_STREAM);
    const response = await post(params, signature);
    const after = await redis.xlen(INBOUND_STREAM);

    expect(response.statusCode).toBe(200);
    expect(after).toBe(before);
  });

  it("firma inválida devuelve 403 y no encola", async () => {
    const params = {
      MessageSid: "webhook-test-sid-2",
      From: "whatsapp:+573000000001",
      To: TENANT_WHATSAPP_NUMBER,
      Body: "Mensaje con firma mala",
    };
    const validSignature = computeTwilioSignature(env.publicWebhookUrl, params);
    const tamperedSignature = validSignature.slice(0, -1) + (validSignature.endsWith("a") ? "b" : "a");

    const before = await redis.xlen(INBOUND_STREAM);
    const response = await post(params, tamperedSignature);
    const after = await redis.xlen(INBOUND_STREAM);

    expect(response.statusCode).toBe(403);
    expect(after).toBe(before);
  });

  it("To desconocido responde 200 sin encolar", async () => {
    const params = {
      MessageSid: "webhook-test-sid-unknown-tenant",
      From: "whatsapp:+573000000001",
      To: "whatsapp:+579999999999",
      Body: "Mensaje a un número que no es de ningún tenant",
    };
    const signature = computeTwilioSignature(env.publicWebhookUrl, params);

    const before = await redis.xlen(INBOUND_STREAM);
    const response = await post(params, signature);
    const after = await redis.xlen(INBOUND_STREAM);

    expect(response.statusCode).toBe(200);
    expect(after).toBe(before);

    await redis.del("wa:processed:webhook-test-sid-unknown-tenant");
  });

  it("supera el límite de rate limiting por IP y responde 429", async () => {
    const params = {
      MessageSid: "webhook-test-sid-ratelimit",
      From: "whatsapp:+573000000001",
      To: TENANT_WHATSAPP_NUMBER,
      Body: "spam",
    };
    const signature = computeTwilioSignature(env.publicWebhookUrl, params);

    // El límite de la ruta es 60/min (ver server.ts) — 65 requests
    // secuenciales alcanzan el límite dentro de la misma ventana, sin
    // importar cuánto cupo hayan consumido los tests anteriores.
    let lastResponse;
    for (let i = 0; i < 65; i++) {
      lastResponse = await post(params, signature);
    }

    expect(lastResponse!.statusCode).toBe(429);
  });
});
