/**
 * Forma del payload entrante de Meta Cloud API. Meta usa **un solo webhook**
 * para mensajes y para callbacks de estado de entrega, y los manda en lotes:
 *
 * ```
 * entry[].changes[].value
 * ├── metadata { phone_number_id, display_phone_number }
 * ├── contacts[] { wa_id, profile.name }
 * ├── messages[] { from, id, timestamp, type, text.body }
 * └── statuses[] { id, status, recipient_id, errors[] }
 * ```
 *
 * Todo se tipa como opcional a propósito: es un payload externo, y asumir que
 * un campo viene siempre es la forma más fácil de que un webhook inesperado
 * tumbe el handler.
 */

export interface MetaContact {
  wa_id?: string;
  profile?: { name?: string };
}

export interface MetaMessage {
  from?: string;
  id?: string;
  /** Unix en segundos, como string. */
  timestamp?: string;
  type?: string;
  text?: { body?: string };
}

export interface MetaStatusError {
  code?: number;
  title?: string;
  message?: string;
}

export interface MetaStatus {
  id?: string;
  status?: string;
  recipient_id?: string;
  errors?: MetaStatusError[];
}

export interface MetaValue {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: MetaContact[];
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
}

export interface MetaWebhookPayload {
  /**
   * Discriminador del canal (Etapa C2): `whatsapp_business_account` para lo de
   * acá, `instagram` para Instagram Direct. Los dos llegan por el mismo
   * webhook, así que este campo es lo único que dice cómo parsear el resto.
   */
  object?: string;
  entry?: Array<{ changes?: Array<{ value?: MetaValue }> }>;
}

/**
 * Parsea el cuerpo crudo. Se parsea acá y no se usa `raw.params` a propósito:
 * la firma se verifica sobre estos mismos bytes, así que parsear lo mismo que
 * se verificó elimina cualquier posibilidad de que ambas cosas diverjan.
 * Devuelve `null` si no es JSON válido — un payload roto no debe lanzar.
 */
export function parseMetaPayload(rawBody: Buffer): MetaWebhookPayload | null {
  try {
    return JSON.parse(rawBody.toString("utf8")) as MetaWebhookPayload;
  } catch {
    return null;
  }
}

/** Aplana `entry[].changes[].value`, que es donde vive todo. */
export function metaValues(payload: MetaWebhookPayload): MetaValue[] {
  return (payload.entry ?? []).flatMap((entry) =>
    (entry.changes ?? []).flatMap((change) => (change.value ? [change.value] : [])),
  );
}
