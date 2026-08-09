import twilio from "twilio";
import type { ConnectionCredentials } from "../../../shared/db/connectionsDirectory.js";
import type { InboundAdapter, NormalizedInbound, RawInboundRequest } from "../types.js";

/**
 * Adapter de entrada de Twilio (WhatsApp). Traslada, sin cambiarla, la lógica
 * que vivía en `src/gateway/twilioSignature.ts` y `webhookHandler.ts`; la
 * única diferencia real es que el auth token ahora entra como parámetro en
 * vez de leerse de `env`, porque la credencial vive por conexión.
 *
 * Ver docs/fase-3-whatsapp-gateway/webhook-contrato.md para el contrato del
 * payload.
 */

function header(raw: RawInboundRequest, name: string): string | undefined {
  const value = raw.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export const twilioInboundAdapter: InboundAdapter = {
  provider: "twilio",

  /**
   * `To` es el número del negocio al que le escribieron — la clave de ruteo
   * natural. Hasta ahora `webhookHandler.ts` lo leía y validaba pero nunca lo
   * usaba (resto de cuando servía para resolver el tenant); acá recupera un
   * propósito.
   */
  identifyConnection(raw: RawInboundRequest): string | null {
    return raw.params.To ?? null;
  },

  verifyRequest(credentials: ConnectionCredentials, raw: RawInboundRequest): boolean {
    const signature = header(raw, "x-twilio-signature");
    if (!signature || !credentials.authToken) {
      return false;
    }
    // Validador oficial del SDK en vez de reimplementar el HMAC a mano, para
    // evitar errores sutiles de encoding y de orden de parámetros.
    return twilio.validateRequest(credentials.authToken, signature, raw.url, raw.params);
  },

  /**
   * Twilio manda siempre un mensaje por request, pero el contrato devuelve
   * array para no bifurcar el llamador entre proveedores. Un payload sin los
   * campos requeridos devuelve `[]`: la firma ya es válida (viene de Twilio),
   * así que no tiene sentido reintentar algo que nunca va a cambiar.
   */
  parseInbound(raw: RawInboundRequest): NormalizedInbound[] {
    const messageSid = raw.params.MessageSid;
    const from = raw.params.From;
    const to = raw.params.To;
    if (!messageSid || !from || !to) {
      return [];
    }
    return [
      {
        externalMessageId: messageSid,
        customerExternalId: from,
        customerName: raw.params.ProfileName || undefined,
        body: raw.params.Body ?? "",
        receivedAt: new Date().toISOString(),
      },
    ];
  },
};
