import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { twilioInboundAdapter } from "../../../../../src/gateway/channels/twilio/inbound.js";
import type { RawInboundRequest } from "../../../../../src/gateway/channels/types.js";

/**
 * Réplica independiente del algoritmo documentado en
 * docs/fase-3-whatsapp-gateway/webhook-contrato.md (HMAC-SHA1 sobre la URL +
 * parámetros ordenados alfabéticamente, concatenados como clave+valor). No
 * depende de internals del SDK de twilio — solo de crypto de Node.
 */
function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

// El token es un parámetro del adapter, no una variable de entorno: por eso
// este test sigue siendo unitario puro, sin base de datos ni .env.
const AUTH_TOKEN = "token-de-prueba-del-adapter";
const URL_WEBHOOK = "https://ejemplo.test/webhooks/whatsapp";

const params = {
  MessageSid: "SM123",
  From: "whatsapp:+573000000000",
  To: "whatsapp:+573000000001",
  Body: "Hola",
};

function rawRequest(
  overrides: Partial<RawInboundRequest> = {},
  signature?: string,
): RawInboundRequest {
  const finalParams = overrides.params ?? params;
  return {
    rawBody: Buffer.from(new URLSearchParams(finalParams).toString()),
    params: finalParams,
    headers: signature === undefined ? {} : { "x-twilio-signature": signature },
    url: URL_WEBHOOK,
    ...overrides,
  };
}

describe("twilioInboundAdapter.verifyRequest", () => {
  it("acepta una firma válida", () => {
    const signature = computeTwilioSignature(AUTH_TOKEN, URL_WEBHOOK, params);
    expect(
      twilioInboundAdapter.verifyRequest({ authToken: AUTH_TOKEN }, rawRequest({}, signature)),
    ).toBe(true);
  });

  it("rechaza una firma alterada", () => {
    const signature = computeTwilioSignature(AUTH_TOKEN, URL_WEBHOOK, params);
    expect(
      twilioInboundAdapter.verifyRequest(
        { authToken: AUTH_TOKEN },
        rawRequest({}, signature.slice(0, -1) + "x"),
      ),
    ).toBe(false);
  });

  it("rechaza cuando no hay header de firma", () => {
    expect(twilioInboundAdapter.verifyRequest({ authToken: AUTH_TOKEN }, rawRequest())).toBe(false);
  });

  it("rechaza si los parámetros no coinciden con los firmados", () => {
    const signature = computeTwilioSignature(AUTH_TOKEN, URL_WEBHOOK, params);
    const alterados = { ...params, Body: "Otro mensaje" };
    expect(
      twilioInboundAdapter.verifyRequest(
        { authToken: AUTH_TOKEN },
        rawRequest({ params: alterados }, signature),
      ),
    ).toBe(false);
  });

  it("rechaza si la credencial es de otra conexión", () => {
    const signature = computeTwilioSignature(AUTH_TOKEN, URL_WEBHOOK, params);
    expect(
      twilioInboundAdapter.verifyRequest({ authToken: "otro-token" }, rawRequest({}, signature)),
    ).toBe(false);
  });

  it("rechaza si la conexión no tiene authToken", () => {
    const signature = computeTwilioSignature(AUTH_TOKEN, URL_WEBHOOK, params);
    expect(twilioInboundAdapter.verifyRequest({}, rawRequest({}, signature))).toBe(false);
  });
});

describe("twilioInboundAdapter.identifyConnection", () => {
  it("usa el campo To como clave de ruteo", () => {
    expect(twilioInboundAdapter.identifyConnection(rawRequest())).toBe("whatsapp:+573000000001");
  });

  it("devuelve null si el payload no trae To", () => {
    const sinTo = { MessageSid: "SM1", From: "whatsapp:+573000000000", Body: "Hola" };
    expect(twilioInboundAdapter.identifyConnection(rawRequest({ params: sinTo }))).toBeNull();
  });
});

describe("twilioInboundAdapter.parseInbound", () => {
  it("normaliza un mensaje de texto", () => {
    const [mensaje, ...resto] = twilioInboundAdapter.parseInbound(
      rawRequest({ params: { ...params, ProfileName: "Rob" } }),
    );

    expect(resto).toHaveLength(0);
    expect(mensaje).toMatchObject({
      externalMessageId: "SM123",
      customerExternalId: "whatsapp:+573000000000",
      customerName: "Rob",
      body: "Hola",
    });
    expect(Date.parse(mensaje!.receivedAt)).not.toBeNaN();
  });

  it("deja customerName undefined si Twilio no manda ProfileName", () => {
    expect(twilioInboundAdapter.parseInbound(rawRequest())[0]?.customerName).toBeUndefined();
  });

  it("trata un cuerpo vacío como cadena vacía, no como payload inválido", () => {
    const sinBody = { MessageSid: "SM1", From: "whatsapp:+57300", To: "whatsapp:+57301" };
    expect(twilioInboundAdapter.parseInbound(rawRequest({ params: sinBody }))[0]?.body).toBe("");
  });

  it("devuelve vacío (no lanza) si faltan campos requeridos", () => {
    const incompleto = { Body: "Hola" };
    expect(twilioInboundAdapter.parseInbound(rawRequest({ params: incompleto }))).toEqual([]);
  });
});
