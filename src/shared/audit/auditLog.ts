import { withTenant } from "../db/index.js";

/**
 * Registra lo que una tool realmente hizo (ver
 * docs/fase-4-motor-agente/auditoria.md) — input propuesto por Claude,
 * output real validado contra Postgres. `audit_log` es insert-only
 * (ver migrations/0009_audit_log.cjs, trigger de inmutabilidad).
 */
export async function recordAudit(
  tenantId: string,
  conversationId: string | null,
  actor: string,
  action: string,
  input: unknown,
  output: unknown,
): Promise<void> {
  await withTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO audit_log (tenant_id, conversation_id, actor, action, input, output)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        tenantId,
        conversationId,
        actor,
        action,
        input === undefined ? null : JSON.stringify(input),
        output === undefined ? null : JSON.stringify(output),
      ],
    ),
  );
}
