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

const TENANT_WHATSAPP_NUMBER = "whatsapp:+573000000099";
let tenantId: string;
const app = buildServer();

beforeAll(async () => {
  const result = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name, whatsapp_number) VALUES ('Gateway Test Tenant', $1) RETURNING id`,
    [TENANT_WHATSAPP_NUMBER],
  );
  tenantId = result.rows[0]!.id;
  await app.ready();
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  await redis.del(INBOUND_STREAM);
  await redis.del("wa:processed:webhook-test-sid-1", "wa:processed:webhook-test-sid-2");
  await app.close();
  await adminPool.end();
  await redis.quit();
  await appPool.end();
});

async function post(params: Record<string, string>, signature: string) {
  return app.inject({
    method: "POST",
    url: "/webhooks/whatsapp",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    payload: params,
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
});
