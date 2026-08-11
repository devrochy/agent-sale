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
const WAMIDS = ["wamid.INTEGRACION1", "wamid.INTEGRACION2", "wamid.SOLOESTADO", "mid.IG1", "mid.IGECO"];

// Instagram (Etapa C2): misma app, mismo webhook, otra conexión.
const IGID = "17841400000000042";
const IGSID = "6789012345678901";

const app = await buildServer();
let connectionId: string;
let instagramConnectionId: string;

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
  instagramConnectionId = await saveConnection({
    channel: "instagram",
    provider: "meta",
    label: "Instagram · Meta (test)",
    externalId: IGID,
    displayAddress: "@formotos_test",
    credentials: {
      appSecret: APP_SECRET,
      accessToken: "token-de-pagina",
      verifyToken: VERIFY_TOKEN,
    },
  });
  await app.ready();
});

afterAll(async () => {
  await redis.del(...WAMIDS.map((id) => `inbound:meta:${id}`));
  // Y las entradas que este test dejó en el stream. Limpiar solo las claves de
  // idempotencia no alcanza: las entradas viejas se acumulan corrida tras
  // corrida y los asserts que buscan "la entrada con este message_sid"
  // terminan encontrando la de una corrida anterior, con el connection_id de
  // una conexión que ya se borró. Pasó de verdad, y el fallo no señala a esto.
  const entradas = await redis.xrange(INBOUND_STREAM, "-", "+");
  const propias = entradas
    .filter(([, campos]) => WAMIDS.includes(campos[campos.indexOf("message_sid") + 1]!))
    .map(([id]) => id);
  if (propias.length > 0) {
    await redis.xdel(INBOUND_STREAM, ...propias);
  }
  await adminPool.query(`DELETE FROM channel_connections WHERE id = ANY($1)`, [
    [connectionId, instagramConnectionId],
  ]);
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

  it("rechaza un hub.mode que no sea subscribe, aunque el token sea correcto", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/webhooks/meta?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1234567890`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain("1234567890");
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

describe("POST /webhooks/meta — Instagram Direct (Etapa C2)", () => {
  function dm(mid: string, texto: string, extra: Record<string, unknown> = {}) {
    return {
      object: "instagram",
      entry: [
        {
          id: IGID,
          time: 1786300000000,
          messaging: [
            {
              sender: { id: IGSID },
              recipient: { id: IGID },
              timestamp: 1786300000000,
              message: { mid, text: texto, ...extra },
            },
          ],
        },
      ],
    };
  }

  it("encola un DM con la conexión de Instagram y su canal", async () => {
    const before = await redis.xlen(INBOUND_STREAM);
    const response = await post(dm("mid.IG1", "Hola por Instagram"));

    expect(response.statusCode).toBe(200);
    expect(await redis.xlen(INBOUND_STREAM)).toBe(before + 1);

    const [entrada] = await redis.xrevrange(INBOUND_STREAM, "+", "-", "COUNT", 1);
    const campos = Object.fromEntries(
      (entrada![1] as string[]).reduce<[string, string][]>(
        (pares, valor, i, arr) => (i % 2 === 0 ? [...pares, [valor, arr[i + 1]!]] : pares),
        [],
      ),
    );
    expect(campos.channel).toBe("instagram");
    expect(campos.connection_id).toBe(instagramConnectionId);
    // El IGSID va verbatim: la identidad es (canal, external_id) desde C1.
    expect(campos.customer_phone).toBe(IGSID);
    expect(campos.body).toBe("Hola por Instagram");
  });

  it("un eco no encola nada: es un mensaje que mandamos nosotros", async () => {
    // Si esto falla, el bot se responde a sí mismo en bucle contra una cuenta
    // real. Es el modo de fallo más caro de toda la etapa.
    const before = await redis.xlen(INBOUND_STREAM);
    const response = await post(dm("mid.IGECO", "Respuesta del bot", { is_echo: true }));

    expect(response.statusCode).toBe(200);
    expect(await redis.xlen(INBOUND_STREAM)).toBe(before);
  });

  it("un IGID desconocido responde 200 sin encolar", async () => {
    const before = await redis.xlen(INBOUND_STREAM);
    const payload = dm("mid.IGDESCONOCIDO", "Hola");
    payload.entry[0]!.id = "17841400000000999";

    const response = await post(payload);

    expect(response.statusCode).toBe(200);
    expect(await redis.xlen(INBOUND_STREAM)).toBe(before);
  });

  it("firma inválida devuelve 403 también para Instagram", async () => {
    const response = await post(dm("mid.IGFIRMA", "Hola"), { secret: "otro-secreto" });
    expect(response.statusCode).toBe(403);
  });
});
