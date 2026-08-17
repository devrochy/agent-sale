import { createHmac, timingSafeEqual } from "node:crypto";
import type { ConnectionCredentials } from "../../../shared/db/connectionsDirectory.js";
import { logger } from "../../../shared/observability/logger.js";
import type {
  DeliveryStatusUpdate,
  InboundAdapter,
  NormalizedInbound,
  RawInboundRequest,
} from "../types.js";
import { metaWaIdToCanonical } from "./addresses.js";
import { metaValues, parseMetaPayload, type MetaValue } from "./payload.js";
import { instagramEntries, type InstagramWebhookPayload } from "./payloadInstagram.js";

/**
 * Adapter de entrada de Meta (Fase 19, Etapas B y C2). Mismo contrato que el
 * de Twilio; lo que cambia es todo lo de abajo: JSON en vez de urlencoded,
 * HMAC-SHA256 sobre el cuerpo crudo en vez de SHA1 sobre la URL, lotes en vez
 * de un mensaje por request, y una clave de ruteo que no es un teléfono.
 *
 * Atiende **dos canales por el mismo endpoint**: WhatsApp Cloud API e
 * Instagram Direct llegan a `/webhooks/meta` desde la misma app, con el mismo
 * App Secret y el mismo handshake. Lo único que los distingue es el `object`
 * del payload, y por eso el despacho se hace acá adentro y no en el registry:
 * `inboundAdapterFor(provider)` se resuelve **antes** de conocer el canal —el
 * canal vive en la conexión, que se encuentra recién con la clave de ruteo que
 * este mismo adapter extrae.
 */

/** El `object` que Meta pone en los webhooks de Instagram Direct. */
const OBJECT_INSTAGRAM = "instagram";

function header(raw: RawInboundRequest, name: string): string | undefined {
  const value = raw.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function nombreDelContacto(value: MetaValue, waId: string): string | undefined {
  const contacto = (value.contacts ?? []).find((c) => c.wa_id === waId);
  return contacto?.profile?.name || undefined;
}

/** El `timestamp` de WhatsApp Cloud API es unix en segundos, como string. */
function receivedAtFrom(timestamp: string | undefined): string {
  const segundos = Number(timestamp);
  if (!Number.isFinite(segundos) || segundos <= 0) {
    return new Date().toISOString();
  }
  return new Date(segundos * 1000).toISOString();
}

/**
 * El de Instagram viene en **milisegundos**, y como número. Tratarlo como
 * segundos no falla ruidosamente: deja todas las fechas en 1970, que es peor,
 * porque el mensaje se procesa igual y el error aparece después en la bandeja.
 */
function receivedAtFromMillis(timestamp: number | undefined): string {
  if (!Number.isFinite(timestamp) || (timestamp ?? 0) <= 0) {
    return new Date().toISOString();
  }
  return new Date(timestamp!).toISOString();
}

/**
 * El contrato devuelve **una** clave de ruteo para todo el request, pero Meta
 * agrupa por app: un lote puede traer mensajes de dos cuentas del mismo
 * negocio, y el HMAC pasa igual porque el App Secret es de la app. Quedarse
 * con la primera mandaría la respuesta por una cuenta a la que el cliente
 * nunca escribió. Se rechaza el lote entero: perder mensajes es malo,
 * contestarlos por la cuenta equivocada es peor.
 */
function unicaClaveDeRuteo(ids: Set<string>): string | null {
  if (ids.size > 1) {
    logger.warn(
      { event: "gateway.lote_meta_multiple", routing_keys: ids.size },
      "Lote de Meta con varias claves de ruteo: se rechaza en vez de atribuirlo a la primera",
    );
    return null;
  }
  return ids.values().next().value ?? null;
}

/**
 * Mensajes de Instagram Direct. Además de la forma distinta del payload, acá
 * está el descarte que no puede fallar: **`is_echo`**.
 *
 * Meta reenvía por este mismo webhook los mensajes que mandó el propio
 * negocio, para que un CRM refleje lo que se respondió desde la app de
 * Instagram. Si no se filtran, el bot lee su propia respuesta como si fuera
 * del cliente, contesta, se vuelve a leer, y queda en un bucle contra una
 * cuenta real — gastando además la cuota de 200 mensajes automatizados por
 * hora que Instagram impone.
 *
 * `sender.id` es el IGSID del cliente y va **verbatim** a `customerExternalId`,
 * sin prefijo: la identidad es `(channel, external_id)` desde la Etapa C1
 * (ADR-037), así que el canal ya lo lleva la columna de al lado.
 */
function parseInstagramInbound(payload: InstagramWebhookPayload): NormalizedInbound[] {
  const mensajes: NormalizedInbound[] = [];
  for (const entry of instagramEntries(payload)) {
    for (const evento of entry.messaging ?? []) {
      const mensaje = evento.message;
      if (!mensaje) {
        // Eventos que no son mensajes (lecturas, reacciones, postbacks).
        continue;
      }
      if (mensaje.is_echo) {
        logger.debug(
          { event: "gateway.eco_instagram_ignorado" },
          "Eco de Instagram ignorado: es un mensaje que mandamos nosotros",
        );
        continue;
      }
      if (!mensaje.mid || !evento.sender?.id || !mensaje.text) {
        // Igual que en WhatsApp: el pipeline de entrada es 100% texto, y un
        // descarte silencioso deja al cliente sin respuesta y sin rastro.
        logger.info(
          { event: "gateway.mensaje_instagram_ignorado", tiene_texto: Boolean(mensaje.text) },
          "Mensaje de Instagram ignorado: el pipeline de entrada solo procesa texto",
        );
        continue;
      }
      mensajes.push({
        externalMessageId: mensaje.mid,
        customerExternalId: evento.sender.id,
        // Instagram no manda el nombre del perfil con el mensaje: el cliente
        // se crea sin nombre hasta que lo diga en la conversación.
        body: mensaje.text,
        receivedAt: receivedAtFromMillis(evento.timestamp),
      });
    }
  }
  return mensajes;
}

export const metaInboundAdapter: InboundAdapter = {
  provider: "meta",

  /**
   * `metadata.phone_number_id` — el identificador del número del negocio en
   * Meta. **No es un teléfono**: por eso la conexión guarda `external_id`
   * (esto) y `display_address` (el número legible) por separado.
   */
  identifyConnection(raw: RawInboundRequest): string | null {
    const payload = parseMetaPayload(raw.rawBody);
    if (!payload) {
      return null;
    }

    const ids = new Set<string>();
    if (payload.object === OBJECT_INSTAGRAM) {
      // El IGID de la cuenta del negocio. Es el mismo valor que el
      // `recipient.id` de cada mensaje entrante, pero se toma de `entry[].id`
      // porque ahí está también en los webhooks que no traen mensajes.
      for (const entry of instagramEntries(payload as InstagramWebhookPayload)) {
        if (entry.id) {
          ids.add(entry.id);
        }
      }
    } else {
      for (const value of metaValues(payload)) {
        const id = value.metadata?.phone_number_id;
        if (id) {
          ids.add(id);
        }
      }
    }
    return unicaClaveDeRuteo(ids);
  },

  /**
   * HMAC-SHA256 sobre el cuerpo crudo con el App Secret, comparado contra el
   * header `X-Hub-Signature-256` (que viene con el prefijo `sha256=`).
   *
   * La comparación es de tiempo constante: comparar firmas con `===` filtra
   * información por el tiempo que tarda en fallar, y es justo el tipo de
   * detalle que no se nota hasta que alguien lo explota.
   */
  verifyRequest(credentials: ConnectionCredentials, raw: RawInboundRequest): boolean {
    const recibida = header(raw, "x-hub-signature-256");
    if (!recibida || !credentials.appSecret || !recibida.startsWith("sha256=")) {
      return false;
    }
    const esperada = createHmac("sha256", credentials.appSecret).update(raw.rawBody).digest("hex");
    const a = Buffer.from(recibida.slice("sha256=".length), "hex");
    const b = Buffer.from(esperada, "hex");
    // timingSafeEqual lanza si difieren en longitud — un hex inválido o
    // truncado en el header no debe tumbar el webhook.
    return a.length === b.length && timingSafeEqual(a, b);
  },

  /**
   * Un webhook puede traer varios mensajes, o ninguno: Meta usa este mismo
   * endpoint para los callbacks de estado de entrega. Devolver `[]` es un
   * resultado normal, no un error (ver `parseDeliveryStatuses`).
   *
   * Solo se normalizan los mensajes de texto. Los de otro tipo (imagen, audio,
   * ubicación) se ignoran en silencio: el pipeline de entrada es 100% texto
   * hoy, igual que con Twilio, y tragarse un tipo desconocido es preferible a
   * encolar un mensaje vacío que el agente respondería sin sentido.
   */
  parseInbound(raw: RawInboundRequest): NormalizedInbound[] {
    const payload = parseMetaPayload(raw.rawBody);
    if (!payload) {
      return [];
    }
    if (payload.object === OBJECT_INSTAGRAM) {
      return parseInstagramInbound(payload as InstagramWebhookPayload);
    }

    const mensajes: NormalizedInbound[] = [];
    for (const value of metaValues(payload)) {
      for (const mensaje of value.messages ?? []) {
        if (mensaje.type !== "text" || !mensaje.id || !mensaje.from) {
          // Sin esto el descarte es invisible: el cliente manda un audio o una
          // foto, no recibe nada, y no queda una sola línea que lo explique.
          logger.info(
            { event: "gateway.mensaje_meta_ignorado", tipo: mensaje.type ?? "desconocido" },
            "Mensaje de Meta ignorado: el pipeline de entrada solo procesa texto",
          );
          continue;
        }
        mensajes.push({
          externalMessageId: mensaje.id,
          customerExternalId: metaWaIdToCanonical(mensaje.from),
          customerName: nombreDelContacto(value, mensaje.from),
          body: mensaje.text?.body ?? "",
          receivedAt: receivedAtFrom(mensaje.timestamp),
        });
      }
    }
    return mensajes;
  },

  parseDeliveryStatuses(raw: RawInboundRequest): DeliveryStatusUpdate[] {
    const payload = parseMetaPayload(raw.rawBody);
    if (!payload) {
      return [];
    }
    // Instagram no manda `statuses[]`: las lecturas llegan por el campo
    // `messaging_seen`, que es otra suscripción y no dice nada sobre rechazos.
    // No hay equivalente al `failed` de WhatsApp, así que no hay nada que
    // reportar acá — un fallo de envío por Instagram se ve en el momento,
    // porque la llamada a la Graph API lanza.
    if (payload.object === OBJECT_INSTAGRAM) {
      return [];
    }

    const estados: DeliveryStatusUpdate[] = [];
    for (const value of metaValues(payload)) {
      for (const estado of value.statuses ?? []) {
        if (!estado.id || !estado.status) {
          continue;
        }
        const error = estado.errors?.[0];
        estados.push({
          externalMessageId: estado.id,
          status: estado.status,
          recipientExternalId: estado.recipient_id
            ? metaWaIdToCanonical(estado.recipient_id)
            : "",
          errorCode: error?.code ?? null,
          errorMessage: error?.message ?? error?.title ?? null,
        });
      }
    }
    return estados;
  },
};
