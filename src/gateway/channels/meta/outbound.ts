import { createHmac } from "node:crypto";
import type {
  ConnectionCredentials,
  ResolvedConnection,
} from "../../../shared/db/connectionsDirectory.js";
import type { VerifiedCredentials, WebhookOutboundAdapter } from "../types.js";
import { canonicalToMetaRecipient } from "./addresses.js";

/**
 * Adapter de salida de Meta Cloud API. Sin SDK: la Graph API es HTTP + JSON y
 * agregar una dependencia para tres llamadas no se paga.
 *
 * Versión de la Graph API: v25.0, publicada en febrero de 2026 y vigente hasta
 * julio de 2028. Se eligió sobre la última (v26.0, de hace unas semanas) por
 * madurez, y sobre las anteriores por vida útil restante. Cuando se acerque su
 * expiración hay que subirla acá y revisar el changelog de Meta.
 */
const GRAPH_API_VERSION = "v25.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

interface GraphError {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

/**
 * La Graph API señala fallas con un objeto `error` en el body. En la mayoría
 * de los casos viene con un status HTTP de error, pero no siempre — así que se
 * chequean las dos cosas y no solo el status.
 */
async function graphRequest<T>(
  url: string,
  init: RequestInit,
  contexto: string,
): Promise<T & GraphError> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & GraphError;

  if (!response.ok || body.error) {
    const detalle = body.error?.message ?? `HTTP ${response.status}`;
    const codigo = body.error?.code !== undefined ? ` (código ${body.error.code})` : "";
    throw new Error(`${contexto}: ${detalle}${codigo}`);
  }
  return body;
}

/**
 * `appsecret_proof`: HMAC-SHA256 del access token con el App Secret como
 * clave. Es el único modo de comprobar el secret sin esperar a que llegue un
 * webhook — Meta lo valida cuando viene y rechaza la llamada si no cuadra.
 */
function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

function requireToken(credentials: ConnectionCredentials): string {
  const { accessToken } = credentials;
  if (!accessToken) {
    throw new Error("La conexión de Meta no tiene accessToken configurado");
  }
  return accessToken;
}

interface SendResponse {
  messages?: Array<{ id?: string }>;
}

interface PhoneNumberResponse {
  display_phone_number?: string;
  verified_name?: string;
}

export const metaOutboundAdapter: WebhookOutboundAdapter = {
  provider: "meta",
  // Meta no admite consultar la entrega por id: la notifica por el mismo
  // webhook entrante (`value.statuses[]`, ver metaInboundAdapter).
  deliveryModel: "webhook",

  async sendText(
    connection: ResolvedConnection,
    to: string,
    text: string,
    mediaUrl?: string,
  ): Promise<string> {
    const token = requireToken(connection.credentials);
    // `connection.externalId` es el phone_number_id: es a la vez la clave de
    // ruteo entrante y el emisor saliente.
    const url = `${GRAPH_API_BASE}/${connection.externalId}/messages`;
    const destinatario = canonicalToMetaRecipient(to);

    // Con media, Meta manda la imagen con el texto como caption en un solo
    // mensaje — a diferencia de Twilio, donde media y cuerpo van juntos en el
    // mismo envío pero como campos separados. El resultado visible es el mismo.
    const payload = mediaUrl
      ? {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: destinatario,
          type: "image",
          image: { link: mediaUrl, caption: text },
        }
      : {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: destinatario,
          type: "text",
          text: { body: text },
        };

    const body = await graphRequest<SendResponse>(
      url,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      "Meta rechazó el envío",
    );

    const id = body.messages?.[0]?.id;
    if (!id) {
      throw new Error("Meta aceptó el envío pero no devolvió un id de mensaje");
    }
    return id;
  },

  /**
   * Lee el propio número: valida el token, el phone number id y el App Secret
   * juntos, sin costo y sin mandarle un mensaje a nadie.
   *
   * El App Secret se valida mandando `appsecret_proof` (HMAC-SHA256 del access
   * token con el secret como clave): si no cuadra, Meta rechaza la llamada.
   * Sin esto un secret mal pegado se guardaba como válido y el síntoma
   * aparecía después y en otro lado — cada webhook entrante fallando la firma,
   * 403, y Meta desactivando la suscripción por reintentos.
   *
   * El verify token **no** se puede validar acá: lo elegimos nosotros y solo
   * Meta lo comprueba, al registrar el webhook. El panel no debe sugerir que sí.
   *
   * A diferencia de Twilio, acá **sí** se puede reportar la dirección: Meta
   * devuelve el número legible, que es distinto del phone_number_id. Es
   * exactamente el caso para el que `external_id` y `display_address` son
   * campos separados desde la Etapa A.
   */
  async verifyCredentials(credentials: ConnectionCredentials): Promise<VerifiedCredentials> {
    const token = requireToken(credentials);
    const phoneNumberId = credentials.phoneNumberId;
    if (!phoneNumberId) {
      throw new Error("Falta el Phone Number ID de la conexión de Meta");
    }

    const params = new URLSearchParams({ fields: "display_phone_number,verified_name" });
    if (credentials.appSecret) {
      params.set("appsecret_proof", appSecretProof(token, credentials.appSecret));
    }

    const body = await graphRequest<PhoneNumberResponse>(
      `${GRAPH_API_BASE}/${phoneNumberId}?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
      "Meta rechazó las credenciales",
    );

    return {
      externalId: phoneNumberId,
      displayAddress: body.display_phone_number ?? null,
    };
  },
};
