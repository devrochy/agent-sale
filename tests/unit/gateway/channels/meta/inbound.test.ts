import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { metaInboundAdapter } from "../../../../../src/gateway/channels/meta/inbound.js";
import type { RawInboundRequest } from "../../../../../src/gateway/channels/types.js";

const APP_SECRET = "app-secret-de-prueba";
const PHONE_NUMBER_ID = "123456789012345";

function firmar(rawBody: Buffer): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(rawBody).digest("hex")}`;
}

function request(payload: unknown, opts: { signature?: string | null } = {}): RawInboundRequest {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = opts.signature === undefined ? firmar(rawBody) : opts.signature;
  return {
    rawBody,
    params: {},
    headers: signature === null ? {} : { "x-hub-signature-256": signature },
    url: "https://ejemplo.test/webhooks/meta",
  };
}

/** Payload de mensaje entrante con la forma real documentada por Meta. */
function mensajeEntrante(overrides: Record<string, unknown> = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "573001234567",
                phone_number_id: PHONE_NUMBER_ID,
              },
              contacts: [{ profile: { name: "Rob" }, wa_id: "573184935933" }],
              messages: [
                {
                  from: "573184935933",
                  id: "wamid.HBgMNTczMTg0OTM1OTMz",
                  timestamp: "1786300000",
                  type: "text",
                  text: { body: "Hola, tienen cascos?" },
                },
              ],
              ...overrides,
            },
          },
        ],
      },
    ],
  };
}

/** Payload de callback de estado — llega por el mismo endpoint, sin mensajes. */
function callbackDeEstado(status: string, error?: { code: number; message: string }) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "573001234567", phone_number_id: PHONE_NUMBER_ID },
              statuses: [
                {
                  id: "wamid.SALIENTE",
                  status,
                  timestamp: "1786300100",
                  recipient_id: "573184935933",
                  ...(error ? { errors: [{ code: error.code, message: error.message }] } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("metaInboundAdapter.identifyConnection", () => {
  it("usa metadata.phone_number_id como clave de ruteo", () => {
    expect(metaInboundAdapter.identifyConnection(request(mensajeEntrante()))).toBe(PHONE_NUMBER_ID);
  });

  it("también la encuentra en un webhook que solo trae estados", () => {
    expect(metaInboundAdapter.identifyConnection(request(callbackDeEstado("delivered")))).toBe(
      PHONE_NUMBER_ID,
    );
  });

  it("devuelve null con un cuerpo que no es JSON, sin lanzar", () => {
    const raw: RawInboundRequest = {
      rawBody: Buffer.from("no soy json"),
      params: {},
      headers: {},
      url: "https://ejemplo.test/webhooks/meta",
    };
    expect(metaInboundAdapter.identifyConnection(raw)).toBeNull();
  });

  it("devuelve null si el payload no trae metadata", () => {
    expect(metaInboundAdapter.identifyConnection(request({ entry: [] }))).toBeNull();
  });

  it("acepta un lote de varias entries si todas son del mismo número", () => {
    const uno = mensajeEntrante();
    const lote = { ...uno, entry: [...uno.entry, ...uno.entry] };

    expect(metaInboundAdapter.identifyConnection(request(lote))).toBe(PHONE_NUMBER_ID);
  });

  it("rechaza el lote que mezcla dos phone_number_id en vez de atribuirlo al primero", () => {
    // Meta agrupa por app, así que un lote puede traer dos números del mismo
    // negocio y la firma pasa igual (el App Secret es de la app). Quedarse con
    // el primero contestaría por un número al que el cliente nunca escribió.
    const uno = mensajeEntrante();
    const otro = JSON.parse(JSON.stringify(uno)) as typeof uno;
    (otro.entry[0]!.changes[0]!.value.metadata as { phone_number_id: string }).phone_number_id =
      "999999999999999";
    const lote = { ...uno, entry: [...uno.entry, ...otro.entry] };

    expect(metaInboundAdapter.identifyConnection(request(lote))).toBeNull();
  });
});

describe("metaInboundAdapter.verifyRequest", () => {
  it("acepta una firma válida", () => {
    expect(metaInboundAdapter.verifyRequest({ appSecret: APP_SECRET }, request(mensajeEntrante()))).toBe(
      true,
    );
  });

  it("rechaza una firma alterada", () => {
    const raw = request(mensajeEntrante());
    const alterada = (raw.headers["x-hub-signature-256"] as string).slice(0, -1) + "0";
    expect(
      metaInboundAdapter.verifyRequest({ appSecret: APP_SECRET }, { ...raw, headers: { "x-hub-signature-256": alterada } }),
    ).toBe(false);
  });

  it("rechaza si falta el header", () => {
    expect(
      metaInboundAdapter.verifyRequest({ appSecret: APP_SECRET }, request(mensajeEntrante(), { signature: null })),
    ).toBe(false);
  });

  it("rechaza una firma sin el prefijo sha256=", () => {
    const raw = request(mensajeEntrante());
    const sinPrefijo = (raw.headers["x-hub-signature-256"] as string).replace("sha256=", "");
    expect(
      metaInboundAdapter.verifyRequest({ appSecret: APP_SECRET }, { ...raw, headers: { "x-hub-signature-256": sinPrefijo } }),
    ).toBe(false);
  });

  it("rechaza con el App Secret de otra conexión", () => {
    expect(
      metaInboundAdapter.verifyRequest({ appSecret: "otro-secreto" }, request(mensajeEntrante())),
    ).toBe(false);
  });

  it("rechaza si la conexión no tiene appSecret", () => {
    expect(metaInboundAdapter.verifyRequest({}, request(mensajeEntrante()))).toBe(false);
  });

  it("no lanza con un header de longitud inválida", () => {
    // timingSafeEqual lanza si los buffers difieren en longitud — un hex
    // truncado en el header no debe tumbar el webhook.
    expect(
      metaInboundAdapter.verifyRequest(
        { appSecret: APP_SECRET },
        { ...request(mensajeEntrante()), headers: { "x-hub-signature-256": "sha256=abcd" } },
      ),
    ).toBe(false);
  });

  it("la firma cubre el cuerpo: cambiar el payload la invalida", () => {
    const original = request(mensajeEntrante());
    const otroCuerpo = Buffer.from(JSON.stringify(mensajeEntrante({ contacts: [] })));
    expect(
      metaInboundAdapter.verifyRequest({ appSecret: APP_SECRET }, { ...original, rawBody: otroCuerpo }),
    ).toBe(false);
  });
});

describe("metaInboundAdapter.parseInbound", () => {
  it("normaliza un mensaje de texto y traduce la dirección al canónico", () => {
    const [mensaje, ...resto] = metaInboundAdapter.parseInbound(request(mensajeEntrante()));

    expect(resto).toHaveLength(0);
    expect(mensaje).toEqual({
      externalMessageId: "wamid.HBgMNTczMTg0OTM1OTMz",
      customerExternalId: "whatsapp:+573184935933",
      customerName: "Rob",
      body: "Hola, tienen cascos?",
      receivedAt: new Date(1786300000 * 1000).toISOString(),
    });
  });

  it("devuelve todos los mensajes de un lote", () => {
    const lote = mensajeEntrante({
      contacts: [
        { profile: { name: "Rob" }, wa_id: "573184935933" },
        { profile: { name: "Ana" }, wa_id: "573009999999" },
      ],
      messages: [
        { from: "573184935933", id: "wamid.1", timestamp: "1786300000", type: "text", text: { body: "Uno" } },
        { from: "573009999999", id: "wamid.2", timestamp: "1786300001", type: "text", text: { body: "Dos" } },
      ],
    });

    const mensajes = metaInboundAdapter.parseInbound(request(lote));
    expect(mensajes.map((m) => m.body)).toEqual(["Uno", "Dos"]);
    expect(mensajes.map((m) => m.customerExternalId)).toEqual([
      "whatsapp:+573184935933",
      "whatsapp:+573009999999",
    ]);
    expect(mensajes[1]!.customerName).toBe("Ana");
  });

  it("devuelve vacío para un webhook que solo trae estados de entrega", () => {
    expect(metaInboundAdapter.parseInbound(request(callbackDeEstado("delivered")))).toEqual([]);
  });

  it("ignora los tipos que el pipeline no procesa, sin encolar un cuerpo vacío", () => {
    const conImagen = mensajeEntrante({
      messages: [
        { from: "573184935933", id: "wamid.img", timestamp: "1786300000", type: "image", image: { id: "x" } },
      ],
    });
    expect(metaInboundAdapter.parseInbound(request(conImagen))).toEqual([]);
  });

  it("deja customerName undefined si no hay contacto que matchee", () => {
    const sinContacto = mensajeEntrante({ contacts: [] });
    expect(metaInboundAdapter.parseInbound(request(sinContacto))[0]?.customerName).toBeUndefined();
  });

  it("cae a la hora actual si el timestamp no es usable", () => {
    const sinTimestamp = mensajeEntrante({
      messages: [{ from: "573184935933", id: "wamid.1", type: "text", text: { body: "Hola" } }],
    });
    const receivedAt = metaInboundAdapter.parseInbound(request(sinTimestamp))[0]!.receivedAt;
    expect(Date.parse(receivedAt)).not.toBeNaN();
  });

  it("no lanza con un cuerpo que no es JSON", () => {
    const raw: RawInboundRequest = {
      rawBody: Buffer.from("{roto"),
      params: {},
      headers: {},
      url: "https://ejemplo.test/webhooks/meta",
    };
    expect(metaInboundAdapter.parseInbound(raw)).toEqual([]);
  });
});

describe("metaInboundAdapter.parseDeliveryStatuses", () => {
  it("extrae un rechazo con su código de error", () => {
    const raw = request(callbackDeEstado("failed", { code: 131047, message: "Re-engagement message" }));
    const [estado] = metaInboundAdapter.parseDeliveryStatuses!(raw);

    expect(estado).toEqual({
      externalMessageId: "wamid.SALIENTE",
      status: "failed",
      recipientExternalId: "whatsapp:+573184935933",
      errorCode: 131047,
      errorMessage: "Re-engagement message",
    });
  });

  it("también reporta los estados no fallidos", () => {
    const [estado] = metaInboundAdapter.parseDeliveryStatuses!(request(callbackDeEstado("delivered")));
    expect(estado).toMatchObject({ status: "delivered", errorCode: null, errorMessage: null });
  });

  it("devuelve vacío para un webhook de mensaje entrante", () => {
    expect(metaInboundAdapter.parseDeliveryStatuses!(request(mensajeEntrante()))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Instagram Direct (Fase 19, Etapa C2). Llega por el MISMO endpoint y con la
// misma firma; lo único que lo distingue es `object`.
// ---------------------------------------------------------------------------

const IGID = "17841400000000001";
const IGSID = "6789012345678901";

function dmDeInstagram(mensaje: Record<string, unknown> = {}) {
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
            message: { mid: "mid.INSTAGRAM1", text: "Hola, tienen cascos?", ...mensaje },
          },
        ],
      },
    ],
  };
}

describe("metaInboundAdapter — Instagram (Etapa C2)", () => {
  it("rutea por entry[].id, que es el IGID de la cuenta del negocio", () => {
    expect(metaInboundAdapter.identifyConnection(request(dmDeInstagram()))).toBe(IGID);
  });

  it("rechaza el lote que mezcla dos IGID en vez de atribuirlo al primero", () => {
    const payload = {
      object: "instagram",
      entry: [
        { id: IGID, messaging: [] },
        { id: "17841400000000999", messaging: [] },
      ],
    };
    expect(metaInboundAdapter.identifyConnection(request(payload))).toBeNull();
  });

  it("normaliza un DM: el IGSID va verbatim, sin prefijo de canal", () => {
    const [mensaje] = metaInboundAdapter.parseInbound(request(dmDeInstagram()));
    expect(mensaje).toEqual({
      externalMessageId: "mid.INSTAGRAM1",
      customerExternalId: IGSID,
      body: "Hola, tienen cascos?",
      receivedAt: new Date(1786300000000).toISOString(),
    });
  });

  it("el timestamp se lee como milisegundos, no como segundos", () => {
    // Tratarlo como segundos no falla ruidosamente: deja la fecha en 1970 y el
    // mensaje se procesa igual, así que el error aparece recién en la bandeja.
    const [mensaje] = metaInboundAdapter.parseInbound(request(dmDeInstagram()));
    expect(new Date(mensaje!.receivedAt).getUTCFullYear()).toBeGreaterThan(2020);
  });

  it("IGNORA un eco: es un mensaje que mandamos nosotros", () => {
    // Sin este filtro el bot lee su propia respuesta como si fuera del
    // cliente, contesta, se vuelve a leer, y queda en un bucle infinito
    // contra una cuenta real.
    const eco = dmDeInstagram({ is_echo: true });
    expect(metaInboundAdapter.parseInbound(request(eco))).toEqual([]);
  });

  it("ignora un evento sin `message` (lecturas, reacciones)", () => {
    const lectura = {
      object: "instagram",
      entry: [
        {
          id: IGID,
          messaging: [{ sender: { id: IGSID }, recipient: { id: IGID }, read: { mid: "mid.X" } }],
        },
      ],
    };
    expect(metaInboundAdapter.parseInbound(request(lectura))).toEqual([]);
  });

  it("ignora un mensaje sin texto (sticker, reel compartido)", () => {
    const adjunto = {
      object: "instagram",
      entry: [
        {
          id: IGID,
          messaging: [
            {
              sender: { id: IGSID },
              recipient: { id: IGID },
              timestamp: 1786300000000,
              message: { mid: "mid.ADJUNTO", attachments: [{ type: "image" }] },
            },
          ],
        },
      ],
    };
    expect(metaInboundAdapter.parseInbound(request(adjunto))).toEqual([]);
  });

  it("devuelve todos los mensajes de un lote de la misma cuenta", () => {
    const lote = {
      object: "instagram",
      entry: [
        {
          id: IGID,
          messaging: [
            {
              sender: { id: IGSID },
              recipient: { id: IGID },
              timestamp: 1786300000000,
              message: { mid: "mid.1", text: "Hola" },
            },
            {
              sender: { id: IGSID },
              recipient: { id: IGID },
              timestamp: 1786300001000,
              message: { mid: "mid.2", text: "Están?" },
            },
          ],
        },
      ],
    };
    expect(metaInboundAdapter.parseInbound(request(lote))).toHaveLength(2);
  });

  it("no reporta estados de entrega: Instagram no manda statuses[]", () => {
    expect(metaInboundAdapter.parseDeliveryStatuses!(request(dmDeInstagram()))).toEqual([]);
  });

  it("la firma se verifica igual que en WhatsApp: es la de la app, no la del canal", () => {
    const req = request(dmDeInstagram());
    expect(metaInboundAdapter.verifyRequest({ appSecret: APP_SECRET }, req)).toBe(true);
    expect(metaInboundAdapter.verifyRequest({ appSecret: "otro" }, req)).toBe(false);
  });

  it("un payload de WhatsApp sigue funcionando igual (no-regresión del despacho)", () => {
    expect(metaInboundAdapter.identifyConnection(request(mensajeEntrante()))).toBe(PHONE_NUMBER_ID);
    expect(metaInboundAdapter.parseInbound(request(mensajeEntrante()))).toHaveLength(1);
  });
});
