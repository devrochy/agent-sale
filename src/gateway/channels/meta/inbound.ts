import { createHmac, timingSafeEqual } from "node:crypto";
import type { ConnectionCredentials } from "../../../shared/db/connectionsDirectory.js";
import type {
  DeliveryStatusUpdate,
  InboundAdapter,
  NormalizedInbound,
  RawInboundRequest,
} from "../types.js";
import { metaWaIdToCanonical } from "./addresses.js";
import { metaValues, parseMetaPayload, type MetaValue } from "./payload.js";

/**
 * Adapter de entrada de Meta Cloud API (Fase 19, Etapa B). Mismo contrato que
 * el de Twilio; lo que cambia es todo lo de abajo: JSON en vez de urlencoded,
 * HMAC-SHA256 sobre el cuerpo crudo en vez de SHA1 sobre la URL, lotes en vez
 * de un mensaje por request, y una clave de ruteo que no es un teléfono.
 */

function header(raw: RawInboundRequest, name: string): string | undefined {
  const value = raw.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function nombreDelContacto(value: MetaValue, waId: string): string | undefined {
  const contacto = (value.contacts ?? []).find((c) => c.wa_id === waId);
  return contacto?.profile?.name || undefined;
}

/** El `timestamp` de Meta es unix en segundos, como string. */
function receivedAtFrom(timestamp: string | undefined): string {
  const segundos = Number(timestamp);
  if (!Number.isFinite(segundos) || segundos <= 0) {
    return new Date().toISOString();
  }
  return new Date(segundos * 1000).toISOString();
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
    for (const value of metaValues(payload)) {
      const id = value.metadata?.phone_number_id;
      if (id) {
        return id;
      }
    }
    return null;
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

    const mensajes: NormalizedInbound[] = [];
    for (const value of metaValues(payload)) {
      for (const mensaje of value.messages ?? []) {
        if (mensaje.type !== "text" || !mensaje.id || !mensaje.from) {
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
