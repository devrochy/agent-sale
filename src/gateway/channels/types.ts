import type {
  ConnectionCredentials,
  Provider,
  ResolvedConnection,
} from "../../shared/db/connectionsDirectory.js";

/**
 * Contrato de canal de la Fase 19 (ver ADR-029). Dos ejes: el canal
 * (whatsapp/instagram/messenger) vive en la conexión, el proveedor
 * (twilio/meta) vive en el adapter — un mismo canal puede tener más de un
 * proveedor activo a la vez.
 *
 * Los adapters son deliberadamente **sin estado y sin acceso a base de
 * datos**: reciben las credenciales como parámetro. Eso es lo que mantiene
 * los tests de verificación de firma como unitarios puros, y lo que evita que
 * la resolución de la conexión se esconda dentro del adapter.
 */

/**
 * Un webhook entrante antes de saber de quién es. Se pasan las cuatro formas
 * porque cada proveedor necesita una distinta: Twilio firma sobre la URL
 * completa más los parámetros ya parseados, Meta hace HMAC sobre los bytes
 * crudos del body. Tiparlo solo como `Buffer` obligaría al adapter de Twilio
 * a re-parsear urlencoded a mano y reintroduciría los bugs de encoding que
 * `twilio.validateRequest` ya resuelve.
 */
export interface RawInboundRequest {
  rawBody: Buffer;
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  /** URL pública exacta del webhook — entra en la firma de Twilio. */
  url: string;
}

/** Un mensaje entrante ya normalizado, sin rastro del proveedor que lo trajo. */
export interface NormalizedInbound {
  /** Identificador del mensaje en el proveedor — base de la idempotencia. */
  externalMessageId: string;
  /** Identidad del cliente en el canal. Para WhatsApp, `whatsapp:+E164`. */
  customerExternalId: string;
  customerName?: string;
  body: string;
  receivedAt: string;
}

export interface InboundAdapter {
  provider: Provider;
  /**
   * Clave de ruteo que dice a qué conexión pertenece el request. Se extrae
   * del payload **todavía sin verificar**, así que sirve únicamente para
   * *buscar* la credencial con la que después se verifica la firma — nunca
   * para confiar en el contenido. `null` si el payload no la trae.
   */
  identifyConnection(raw: RawInboundRequest): string | null;
  verifyRequest(credentials: ConnectionCredentials, raw: RawInboundRequest): boolean;
  /**
   * Devuelve un array porque Meta manda lotes (`entry[].changes[]`) y porque
   * un webhook puede no traer ningún mensaje (Meta usa el mismo endpoint para
   * los callbacks de estado de entrega). Un array vacío es un resultado
   * **normal**, no un error.
   */
  parseInbound(raw: RawInboundRequest): NormalizedInbound[];
}

export interface MessageDeliveryStatus {
  status: string;
  errorCode: number | null;
}

/** Lo que confirma una credencial válida, para no pedirle al admin que tipee la clave de ruteo. */
export interface VerifiedCredentials {
  externalId: string;
  displayAddress: string | null;
}

interface OutboundAdapterBase {
  provider: Provider;
  /** Devuelve el id del mensaje en el proveedor. */
  sendText(
    connection: ResolvedConnection,
    to: string,
    text: string,
    mediaUrl?: string,
  ): Promise<string>;
  /** Valida credenciales contra el proveedor sin enviarle un mensaje a nadie. */
  verifyCredentials(credentials: ConnectionCredentials): Promise<VerifiedCredentials>;
}

/**
 * Twilio: la entrega real se consulta por id (ver verifyDelivery.ts, que nació
 * de un hallazgo de QA — el 63016 de "fuera de la ventana de 24h" llega en
 * silencio, sin que el envío lance).
 */
export interface PollingOutboundAdapter extends OutboundAdapterBase {
  deliveryModel: "poll";
  getDeliveryStatus(
    connection: ResolvedConnection,
    messageId: string,
  ): Promise<MessageDeliveryStatus>;
}

/** Meta: no hay consulta por id, el estado llega por webhook. */
export interface WebhookOutboundAdapter extends OutboundAdapterBase {
  deliveryModel: "webhook";
}

/**
 * Unión discriminada a propósito: `deliveryModel` obliga a TypeScript a
 * estrechar antes de poder llamar a `getDeliveryStatus`. Si fuera un método
 * opcional, el port natural sería `if (!adapter.getDeliveryStatus) return`,
 * que borraría en silencio el propósito de verifyDelivery.ts.
 */
export type OutboundAdapter = PollingOutboundAdapter | WebhookOutboundAdapter;
