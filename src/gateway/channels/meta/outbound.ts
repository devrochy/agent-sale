import type {
  Channel,
  ConnectionCredentials,
  ResolvedConnection,
} from "../../../shared/db/connectionsDirectory.js";
import type { VerifiedCredentials, WebhookOutboundAdapter } from "../types.js";
import { canonicalToMetaRecipient } from "./addresses.js";
import { appSecretProof, graphRequest, GRAPH_API_BASE, requireToken } from "./graph.js";

/**
 * Adapter de salida de Meta. Sin SDK: la Graph API es HTTP + JSON y agregar
 * una dependencia para cuatro llamadas no se paga.
 *
 * Atiende dos canales con **dos APIs distintas**, y esa es la corrección que
 * trajo la Etapa C2: WhatsApp y Instagram comparten host, webhook y App
 * Secret, pero no el endpoint de envío ni la forma del cuerpo. El despacho es
 * por `connection.channel` porque acá sí se conoce la conexión — a diferencia
 * de la entrada, donde el canal todavía no se sabe y hay que mirar el payload.
 *
 * | | WhatsApp Cloud API | Instagram Messaging |
 * |---|---|---|
 * | endpoint | `/{phone_number_id}/messages` | `/me/messages` |
 * | destinatario | `to: "<wa_id>"` | `recipient: { id: "<IGSID>" }` |
 * | id devuelto | `messages[0].id` | `message_id` |
 * | imagen + texto | un envío (caption) | **dos** envíos |
 */

interface WhatsAppSendResponse {
  messages?: Array<{ id?: string }>;
}

interface InstagramSendResponse {
  recipient_id?: string;
  message_id?: string;
}

interface PhoneNumberResponse {
  display_phone_number?: string;
  verified_name?: string;
}

interface InstagramAccountResponse {
  instagram_business_account?: { id?: string; username?: string };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function enviarPorWhatsApp(
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

  const body = await graphRequest<WhatsAppSendResponse>(
    url,
    { method: "POST", headers: authHeaders(token), body: JSON.stringify(payload) },
    "Meta rechazó el envío",
  );

  const id = body.messages?.[0]?.id;
  if (!id) {
    throw new Error("Meta aceptó el envío pero no devolvió un id de mensaje");
  }
  return id;
}

/**
 * `/me/messages` y no `/{page_id}/messages`: el token de Página ya identifica
 * la Página, así que la conexión no necesita guardar el Page ID además del
 * IGID que usa para rutear la entrada.
 *
 * Instagram **no admite texto y adjunto en el mismo mensaje**, así que con
 * `mediaUrl` van dos envíos: primero la imagen, después el texto. Se devuelve
 * el id del último, que es el que corresponde al texto — el mismo criterio que
 * en WhatsApp, donde el único id devuelto es el del mensaje con caption.
 */
async function enviarPorInstagram(
  connection: ResolvedConnection,
  to: string,
  text: string,
  mediaUrl?: string,
): Promise<string> {
  const token = requireToken(connection.credentials);
  const url = `${GRAPH_API_BASE}/me/messages`;
  const headers = authHeaders(token);

  async function enviar(message: Record<string, unknown>): Promise<string> {
    const body = await graphRequest<InstagramSendResponse>(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ recipient: { id: to }, message }),
      },
      "Instagram rechazó el envío",
    );
    const id = body.message_id;
    if (!id) {
      throw new Error("Instagram aceptó el envío pero no devolvió un id de mensaje");
    }
    return id;
  }

  if (mediaUrl) {
    await enviar({ attachment: { type: "image", payload: { url: mediaUrl } } });
  }
  return enviar({ text });
}

export const metaOutboundAdapter: WebhookOutboundAdapter = {
  provider: "meta",
  // Meta no admite consultar la entrega por id: la notifica por el mismo
  // webhook entrante (`value.statuses[]`, ver metaInboundAdapter). Para
  // Instagram no la notifica en absoluto — un fallo de envío se ve acá mismo,
  // porque la llamada lanza.
  deliveryModel: "webhook",

  async sendText(
    connection: ResolvedConnection,
    to: string,
    text: string,
    mediaUrl?: string,
  ): Promise<string> {
    if (connection.channel === "instagram" || connection.channel === "messenger") {
      return enviarPorInstagram(connection, to, text, mediaUrl);
    }
    return enviarPorWhatsApp(connection, to, text, mediaUrl);
  },

  /**
   * Valida las credenciales contra el proveedor sin mandarle un mensaje a
   * nadie, y de paso deduce la clave de ruteo. Recibe el canal porque lo que
   * hay que leer es distinto en cada uno — y porque la clave de ruteo de
   * Instagram (el IGID) no está en las credenciales que tipea el admin: la
   * tiene que reportar Meta.
   *
   * El App Secret se valida mandando `appsecret_proof` (HMAC-SHA256 del access
   * token con el secret como clave): si no cuadra, Meta rechaza la llamada.
   * Sin esto un secret mal pegado se guardaba como válido y el síntoma
   * aparecía después y en otro lado — cada webhook entrante fallando la firma,
   * 403, y Meta desactivando la suscripción por reintentos.
   *
   * El verify token **no** se puede validar acá: lo elegimos nosotros y solo
   * Meta lo comprueba, al registrar el webhook. El panel no debe sugerir que sí.
   */
  async verifyCredentials(
    credentials: ConnectionCredentials,
    channel: Channel,
  ): Promise<VerifiedCredentials> {
    const token = requireToken(credentials);
    const params = new URLSearchParams();
    if (credentials.appSecret) {
      params.set("appsecret_proof", appSecretProof(token, credentials.appSecret));
    }

    if (channel === "instagram" || channel === "messenger") {
      // `/me` con un token de Página es la Página. Pedirle la cuenta de
      // Instagram vinculada valida de una sola llamada el token, el App Secret
      // y —lo que más se rompe al configurar— que la vinculación exista.
      params.set("fields", "instagram_business_account{id,username}");
      const body = await graphRequest<InstagramAccountResponse>(
        `${GRAPH_API_BASE}/me?${params}`,
        { headers: { Authorization: `Bearer ${token}` } },
        "Meta rechazó las credenciales",
      );

      const cuenta = body.instagram_business_account;
      if (!cuenta?.id) {
        throw new Error(
          "El token es válido pero la Página no tiene una cuenta de Instagram vinculada. " +
            "Vinculalas desde la app de Instagram (Editar perfil → Página) y volvé a intentar.",
        );
      }
      return {
        externalId: cuenta.id,
        displayAddress: cuenta.username ? `@${cuenta.username}` : null,
      };
    }

    const phoneNumberId = credentials.phoneNumberId;
    if (!phoneNumberId) {
      throw new Error("Falta el Phone Number ID de la conexión de Meta");
    }

    // A diferencia de Twilio, acá sí se puede reportar la dirección: Meta
    // devuelve el número legible, que es distinto del phone_number_id. Es
    // exactamente el caso para el que `external_id` y `display_address` son
    // campos separados desde la Etapa A.
    params.set("fields", "display_phone_number,verified_name");
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
