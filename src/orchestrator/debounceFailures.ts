import { withTransaction } from "../shared/db/withTransaction.js";

/**
 * Registro persistente de un turno diferido (ver debounceScheduler.ts,
 * `fireConversation`) que agotó sus reintentos — Fase 2 del plan de
 * remediación del incidente 2026-09-13 (ADR-022 lo dejaba como límite
 * conocido: el error solo quedaba en el log, nadie se enteraba salvo que
 * revisara Loki a mano). `debounce_failures` (migrations/0062) es el
 * mínimo viable para que un humano lo pueda consultar por SQL; surfacearlo
 * en el panel admin queda como incremento futuro.
 */
export async function recordDebounceFailure(
  conversationId: string,
  error: unknown,
  attempts: number,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await withTransaction((client) =>
    client.query(
      `INSERT INTO debounce_failures (conversation_id, error_message, attempts) VALUES ($1, $2, $3)`,
      [conversationId, message, attempts],
    ),
  );
}
