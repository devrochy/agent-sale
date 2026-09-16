import { withTransaction } from "../shared/db/index.js";
import { logger } from "../shared/observability/logger.js";

interface CandidateRow {
  id: string;
}

/**
 * Conversaciones con al menos un pedido pagado y sin ningún mensaje
 * entrante del cliente en las últimas 12h (pedido explícito del usuario:
 * "que una conversación se cierre cuando esté pagada y no se registre
 * actividad futura"). Se excluyen las que tienen un ticket abierto
 * (`queued`/`en_atencion`): si hay un humano atendiendo o un caso sin
 * tomar, ese ciclo lo cierra `resolverTicket` (adminPanel.ts), no este
 * job — cerrarla acá se pisaría con esa lógica.
 */
async function fetchCandidates(): Promise<CandidateRow[]> {
  return withTransaction(async (client) => {
    const result = await client.query<CandidateRow>(
      `SELECT conv.id
         FROM conversations conv
        WHERE conv.status = 'open'
          AND EXISTS (SELECT 1 FROM orders o WHERE o.conversation_id = conv.id AND o.payment_status = 'pagado')
          AND NOT EXISTS (
            SELECT 1 FROM messages m
             WHERE m.conversation_id = conv.id
               AND m.direction = 'inbound' AND m.sender_type = 'customer'
               AND m.created_at >= now() - interval '12 hours'
          )
          AND NOT EXISTS (
            SELECT 1 FROM handoff_queue hq
             WHERE hq.conversation_id = conv.id AND hq.status IN ('queued', 'en_atencion')
          )`,
    );
    return result.rows;
  });
}

/** Guard idempotente: si llegó un mensaje justo antes de esta corrida, `status` ya no es 'open' con las condiciones de arriba y la UPDATE no afecta nada. */
async function closeConversation(conversationId: string): Promise<boolean> {
  const result = await withTransaction((client) =>
    client.query<{ id: string }>(
      `UPDATE conversations SET status = 'closed', closed_at = now() WHERE id = $1 AND status = 'open' RETURNING id`,
      [conversationId],
    ),
  );
  return result.rows.length > 0;
}

/**
 * A diferencia de closeExpiredOrders.ts, acá no hay nada que notificarle
 * al cliente — no se cancela ni se cambia ningún pedido, solo se archiva
 * el hilo. Una conversación cerrada se reabre sola (resolveConversation,
 * ver orchestrator/memory.ts) si el cliente vuelve a escribir dentro de
 * las 24h siguientes.
 */
export async function runCloseInactivePaidConversations(): Promise<void> {
  const jobLogger = logger.child({ event: "jobs.cerrar_conversaciones_pagadas_inactivas" });
  try {
    const candidates = await fetchCandidates();
    for (const candidate of candidates) {
      try {
        await closeConversation(candidate.id);
      } catch (error) {
        jobLogger.warn({ error, conversation_id: candidate.id }, "No se pudo cerrar esta conversación");
      }
    }
  } catch (error) {
    jobLogger.warn({ error }, "No se pudo correr el cierre de conversaciones pagadas inactivas");
  }
}
