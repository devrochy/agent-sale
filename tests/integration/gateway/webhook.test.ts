import crypto from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../../src/config/env.js";
import {
  invalidateConnectionsCache,
  saveConnection,
  setConnectionActive,
} from "../../../src/shared/db/connectionsDirectory.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { redis } from "../../../src/shared/redis/client.js";
import { buildServer } from "../../../src/gateway/server.js";
import { INBOUND_STREAM } from "../../../src/gateway/queue.js";

function computeTwilioSignature(url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto
    .createHmac("sha1", env.twilioAuthToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");
}

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const TENANT_WHATSAPP_NUMBER = `whatsapp:+5730000${String(Date.now()).slice(-6)}`;
// Un número que no corresponde a ninguna conexión configurada.
const NUMERO_SIN_CONEXION = "whatsapp:+570000000404";
const app = await buildServer();
let connectionId: string;

const SIDS = [
  "webhook-test-sid-1",
  "webhook-test-sid-2",
  "webhook-test-sid-ratelimit",
  "webhook-test-sid-profilename",
  "webhook-test-sid-desconocido",
  "webhook-test-sid-inactiva",
];

beforeAll(async () => {
  // El webhook rutea por el campo `To` (Fase 19): sin una conexión que
  // matchee, el request se descarta con 200 sin encolar.
  connectionId = await saveConnection({
    channel: "whatsapp",
    provider: "twilio",
    label: "WhatsApp Test Webhook",
    externalId: TENANT_WHATSAPP_NUMBER,
    displayAddress: TENANT_WHATSAPP_NUMBER,
    credentials: { accountSid: "ACtest", authToken: env.twilioAuthToken },
  });
  await app.ready();
});

afterAll(async () => {
  await redis.del(INBOUND_STREAM);
  await redis.del(...SIDS.map((sid) => `inbound:twilio:${sid}`));
  await adminPool.query("DELETE FROM channel_connections WHERE id = $1", [connectionId]);
  invalidateConnectionsCache();
  await app.close();
  await redis.quit();
  await adminPool.end();
  await appPool.end();
});

async function post(params: Record<string, string>, signature: string) {
  // app.inject() serializa cualquier payload que no sea string/Buffer como
  // JSON, sin importar el content-type que se le ponga — hay que
  // construir el string application/x-www-form-urlencoded a mano para que
  // el parser lo lea igual que un webhook real de Twilio.
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

  it("encola la conexión y el canal por los que entró el mensaje", async () => {
    const entries = await redis.xrange(INBOUND_STREAM, "-", "+");
    const match = entries.find(([, fields]: [string, string[]]) =>
      fields.includes("webhook-test-sid-1"),
    );
    const fields = match![1];

    expect(fields[fields.indexOf("connection_id") + 1]).toBe(connectionId);
    expect(fields[fields.indexOf("channel") + 1]).toBe("whatsapp");
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

  it("un To que no corresponde a ninguna conexión responde 200 y no encola", async () => {
    // 200 y no 403/404 a propósito: con un no-2xx Twilio reintentaría
    // indefinidamente un request que nunca va a cambiar.
    const params = {
      MessageSid: "webhook-test-sid-desconocido",
      From: "whatsapp:+573000000001",
      To: NUMERO_SIN_CONEXION,
      Body: "Mensaje a un número no configurado",
    };
    const signature = computeTwilioSignature(env.publicWebhookUrl, params);

    const before = await redis.xlen(INBOUND_STREAM);
    const response = await post(params, signature);
    const after = await redis.xlen(INBOUND_STREAM);

    expect(response.statusCode).toBe(200);
    expect(after).toBe(before);
  });

  it("una conexión inactiva responde 200 y no encola", async () => {
    await setConnectionActive(connectionId, false);
    const params = {
      MessageSid: "webhook-test-sid-inactiva",
      From: "whatsapp:+573000000001",
      To: TENANT_WHATSAPP_NUMBER,
      Body: "Mensaje a una conexión apagada",
    };
    const signature = computeTwilioSignature(env.publicWebhookUrl, params);

    const before = await redis.xlen(INBOUND_STREAM);
    const response = await post(params, signature);
    const after = await redis.xlen(INBOUND_STREAM);

    expect(response.statusCode).toBe(200);
    expect(after).toBe(before);

    await setConnectionActive(connectionId, true);
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

describe("parser de cuerpo crudo de los webhooks (regresión)", () => {
  /**
   * El adapter de Meta (Etapa B) necesita los bytes crudos del body para su
   * HMAC-SHA256, y Fastify los descarta al parsear. El parser que los
   * conserva está encapsulado en el plugin de webhooks justamente para no
   * reemplazar el de JSON de toda la app: declarado global, `/webhooks/wompi`
   * recibiría un Buffer donde espera un objeto y dejaría de procesar pagos.
   */
  it("/webhooks/wompi sigue recibiendo su JSON ya parseado", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/wompi",
      headers: { "content-type": "application/json" },
      payload: { event: "transaction.updated", data: {} },
    });

    // Sin firma válida el handler rechaza (401), que es exactamente lo que
    // debe pasar: llegó como objeto y se evaluó. Un 400/500 significaría que
    // el body no se parseó.
    expect([200, 401]).toContain(response.statusCode);
  });
});
