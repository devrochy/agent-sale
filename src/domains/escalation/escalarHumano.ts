import { withTenant } from "../../shared/db/index.js";

export type EscalationReason =
  | "compatibilidad_tecnica"
  | "monto_alto"
  | "solicitud_cliente"
  | "intentos_fallidos"
  | "queja";

export interface EscalarHumanoInput {
  reason: EscalationReason;
  summary: string;
}

export interface EscalarHumanoOutput {
  handoff_id: string;
  status: "queued";
  assigned_to: string | null;
}

/**
 * Tool escalar_a_humano (ver docs/fase-1-arquitectura/contratos-tools.md).
 * La decisión de *cuándo* llamarla es del orchestrator (reglas
 * explícitas), no de esta función — aquí solo se registra en
 * handoff_queue. Asignar un asesor específico es Fase 7.
 */
export async function escalarHumano(
  tenantId: string,
  conversationId: string,
  input: EscalarHumanoInput,
): Promise<EscalarHumanoOutput> {
  const handoffId = await withTenant(tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO handoff_queue (tenant_id, conversation_id, reason, status, summary)
       VALUES ($1, $2, $3, 'queued', $4)
       RETURNING id`,
      [tenantId, conversationId, input.reason, input.summary],
    );
    return result.rows[0]!.id;
  });

  return { handoff_id: handoffId, status: "queued", assigned_to: null };
}
