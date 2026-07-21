import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { env } from "../../../src/config/env.js";
import { verifyTwilioSignature } from "../../../src/gateway/twilioSignature.js";

/**
 * Réplica independiente del algoritmo documentado en
 * docs/fase-3-whatsapp-gateway/webhook-contrato.md (HMAC-SHA1 sobre la URL
 * + parámetros ordenados alfabeticamente, concatenados como clave+valor).
 * No depende de internals del SDK de twilio — solo de crypto de Node.
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

describe("verifyTwilioSignature", () => {
  const params = {
    MessageSid: "SM123",
    From: "whatsapp:+573000000000",
    To: "whatsapp:+573000000001",
    Body: "Hola",
  };

  it("acepta una firma válida", () => {
    const signature = computeTwilioSignature(env.twilioAuthToken, env.publicWebhookUrl, params);
    expect(verifyTwilioSignature(params, signature)).toBe(true);
  });

  it("rechaza una firma alterada", () => {
    const signature = computeTwilioSignature(env.twilioAuthToken, env.publicWebhookUrl, params);
    expect(verifyTwilioSignature(params, signature.slice(0, -1) + "x")).toBe(false);
  });

  it("rechaza cuando no hay header de firma", () => {
    expect(verifyTwilioSignature(params, undefined)).toBe(false);
  });

  it("rechaza si los parámetros no coinciden con los firmados", () => {
    const signature = computeTwilioSignature(env.twilioAuthToken, env.publicWebhookUrl, params);
    expect(verifyTwilioSignature({ ...params, Body: "Otro mensaje" }, signature)).toBe(false);
  });
});
