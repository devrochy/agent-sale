/**
 * Forma del payload entrante de Instagram Messaging (Fase 19, Etapa C2).
 *
 * Llega **por el mismo webhook** que WhatsApp Cloud API — es la misma app de
 * Meta y el mismo App Secret— pero con otro `object` y otra estructura:
 *
 * ```
 * { object: "instagram",
 *   entry[] { id, time, messaging[] { sender.id, recipient.id, timestamp,
 *                                     message { mid, text, is_echo } } } }
 * ```
 *
 * Las diferencias con `payload.ts` que importan:
 *
 * - La clave de ruteo es `entry[].id` (el IGID de la cuenta del negocio), no
 *   un campo dentro de `value.metadata`.
 * - Los mensajes cuelgan de `entry[].messaging[]`, no de
 *   `entry[].changes[].value.messages[]`.
 * - `timestamp` viene en **milisegundos**. El de WhatsApp viene en segundos.
 * - No hay `contacts[]`: Instagram no manda el nombre del perfil junto al
 *   mensaje, así que el cliente se crea sin nombre hasta que lo diga.
 *
 * Todo se tipa opcional por la misma razón que en `payload.ts`: es un payload
 * externo, y asumir que un campo viene siempre es la forma más fácil de que un
 * webhook inesperado tumbe el handler.
 */

export interface InstagramMessage {
  /** Id del mensaje en Meta — base de la idempotencia. */
  mid?: string;
  text?: string;
  /**
   * `true` en los mensajes que mandó el **propio negocio**. Meta los reenvía
   * por el mismo webhook para que un CRM pueda reflejar lo que se respondió
   * desde la app de Instagram.
   *
   * Filtrarlos no es opcional: sin eso el bot lee sus propias respuestas como
   * si fueran del cliente, contesta, vuelve a leerse, y entra en un bucle
   * contra una cuenta real.
   */
  is_echo?: boolean;
}

export interface InstagramMessaging {
  /** Quien escribe. En un mensaje del cliente, su IGSID. */
  sender?: { id?: string };
  /** A quién le escriben. En un mensaje del cliente, el IGID del negocio. */
  recipient?: { id?: string };
  /** Unix en **milisegundos**. */
  timestamp?: number;
  message?: InstagramMessage;
}

export interface InstagramEntry {
  /** IGID de la cuenta del negocio — la clave de ruteo. */
  id?: string;
  time?: number;
  messaging?: InstagramMessaging[];
}

export interface InstagramWebhookPayload {
  object?: string;
  entry?: InstagramEntry[];
}

/** Aplana `entry[]`, filtrando las entradas sin nada adentro. */
export function instagramEntries(payload: InstagramWebhookPayload): InstagramEntry[] {
  return payload.entry ?? [];
}
