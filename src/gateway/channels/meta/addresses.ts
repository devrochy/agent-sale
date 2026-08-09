/**
 * Traducción de direcciones entre Meta y el formato canónico del sistema.
 *
 * El canónico es `whatsapp:+E164` (regla fijada en ADR-029): el prefijo es
 * sintaxis de transporte de Twilio, pero se conserva como formato interno
 * porque está grabado en `customers.phone_number`, en `admins.phone` y en los
 * helpers del panel. **El adapter es el único dueño de traducirlo.**
 *
 * Meta manda y recibe el `wa_id` en dígitos pelados: `573184935933`.
 *
 * Regla crítica: el `wa_id` se hace **round-trip verbatim**, sin "corregirlo".
 * Para algunos países el `wa_id` no coincide con el número que uno marcaría
 * (México antepone un `1`, Argentina un `9`); intentar normalizarlo a un E.164
 * "real" haría que la respuesta no llegue. Y si la traducción no round-trippea,
 * el mismo humano termina como dos filas de `customers`, partiendo historial de
 * pedidos, `bot_paused` y datos de entrega.
 */

/** `573184935933` → `whatsapp:+573184935933` */
export function metaWaIdToCanonical(waId: string): string {
  return `whatsapp:+${waId.replace(/^\+/, "")}`;
}

/** `whatsapp:+573184935933` → `573184935933` */
export function canonicalToMetaRecipient(canonical: string): string {
  return canonical.replace(/^whatsapp:/, "").replace(/^\+/, "");
}
