import { createHmac } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../../src/gateway/server.js";
import { INBOUND_STREAM } from "../../../src/gateway/queue.js";
import {
  invalidateConnectionsCache,
  saveConnection,
} from "../../../src/shared/db/connectionsDirectory.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { redis } from "../../../src/shared/redis/client.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const APP_SECRET = "app-secret-integracion";
const VERIFY_TOKEN = "verify-token-integracion";
const PHONE_NUMBER_ID = "999888777666555";
const WAMIDS = ["wamid.INTEGRACION1", "wamid.INTEGRACION2", "wamid.SOLOESTADO"];

const app = await buildServer();
let connectionId: string;

beforeAll(async () => {
  connectionId = await saveConnection({
    channel: "whatsapp",
    provider: "meta",
    label: "WhatsApp · Meta (test)",
    externalId: PHONE_NUMBER_ID,
    displayAddress: "+57 300 111 2222",
    credentials: {
      phoneNumberId: PHONE_NUMBER_ID,
      appSecret: APP_SECRET,
      accessToken: "token-de-prueba",
      verifyToken: VERIFY_TOKEN,
    },
  });
  await app.ready();
});

afterAll(async () => {
  await redis.del(...WAMIDS.map((id) => `inbound:meta:${id}`));
  await adminPool.query(`DELETE FROM channel_connections WHERE id = $1`, [connectionId]);
  invalidateConnectionsCache();
  await app.close();
  await redis.quit();
  await adminPool.end();
  await appPool.end();
});

function post(payload: unknown, opts: { secret?: string } = {}) {
  const body = JSON.stringify(payload);
  const firma = createHmac("sha256", opts.secret ?? APP_SECRET).update(Buffer.from(body)).digest("hex");
  return app.inject({
    method: "POST",
    url: "/webhooks/meta",
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${firma}` },
    payload: body,
  });
}

function mensaje(wamid: string, texto: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: "573001112222", phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name: "Rob" }, wa_id: "573184935933" }],
              messages: [
                { from: "573184935933", id: wamid, timestamp: "1786300000", type: "text", text: { body: texto } },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("GET /webhooks/meta — handshake de verificación", () => {
  it("devuelve el challenge cuando el verify token coincide", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1234567890`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("1234567890");
  });

  it("rechaza con 403 un verify token incorrecto", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/webhooks/meta?hub.mode=subscribe&hub.verify_token=token-equivocado&hub.challenge=1234567890",
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain("1234567890");
  });

  it("rechaza si no viene el verify token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/webhooks/meta?hub.mode=subscribe&hub.challenge=1234567890",
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("POST /webhooks/meta — mensajes entrantes", () => {
  it("encola un mensaje con firma válida, con su conexión y canal", async () => {
    const response = await post(mensaje(WAMIDS[0]!, "Hola desde Meta"));
    expect(response.statusCode).toBe(200);

    const entries = await redis.xrange(INBOUND_STREAM, "-", "+");
    const match = entries.find(([, fields]: [string, string[]]) => fields.includes(WAMIDS[0]!));
    expect(match).toBeDefined();

    const fields = match![1];
    expect(fields[fields.indexOf("connection_id") + 1]).toBe(connectionId);
    expect(fields[fields.indexOf("channel") + 1]).toBe("whatsapp");
    // La dirección llega traducida al canónico del sistema, no como la manda
    // Meta (dígitos pelados) — si no, sería otro cliente distinto.
    expect(fields[fields.indexOf("customer_phone") + 1]).toBe("whatsapp:+573184935933");
    expect(fields[fields.indexOf("customer_name") + 1]).toBe("Rob");
  });

  it("firma inválida devuelve 403 y no encola", async () => {
    const before = await redis.xlen(INBOUND_STREAM);
    const response = await post(mensaje(WAMIDS[1]!, "Firma mala"), { secret: "otro-secreto" });
    const after = await redis.xlen(INBOUND_STREAM);

    expect(response.statusCode).toBe(403);
    expect(after).toBe(before);
  });

  it("un phone_number_id desconocido responde 200 sin encolar", async () => {
    const desconocido = mensaje(WAMIDS[1]!, "A otro número");
    desconocido.entry[0]!.changes[0]!.value.metadata.phone_number_id = "000000000000000";

    const before = await redis.xlen(INBOUND_STREAM);
    const response = await post(desconocido);
    const after = await redis.xlen(INBOUND_STREAM);

    expect(response.statusCode).toBe(200);
    expect(after).toBe(before);
  });

  it("el mismo wamid reenviado no se duplica", async () => {
    const before = await redis.xlen(INBOUND_STREAM);
    const response = await post(mensaje(WAMIDS[0]!, "Hola desde Meta"));
    const after = await redis.xlen(INBOUND_STREAM);

    expect(response.statusCode).toBe(200);
    expect(after).toBe(before);
  });
});

describe("POST /webhooks/meta — callbacks de estado de entrega", () => {
  it("un webhook que solo trae estados responde 200 y no encola nada", async () => {
    const soloEstado = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: "573001112222", phone_number_id: PHONE_NUMBER_ID },
                statuses: [
                  {
                    id: WAMIDS[2]!,
                    status: "failed",
                    timestamp: "1786300100",
                    recipient_id: "573184935933",
                    errors: [{ code: 131047, message: "Re-engagement message" }],
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const before = await redis.xlen(INBOUND_STREAM);
    const response = await post(soloEstado);
    const after = await redis.xlen(INBOUND_STREAM);

    // No es un payload inválido: es el camino por el que Meta avisa que un
    // mensaje ya enviado fue rechazado — la señal equivalente al 63016 de
    // Twilio, que sin esto se perdería en silencio.
    expect(response.statusCode).toBe(200);
    expect(after).toBe(before);
  });
});
