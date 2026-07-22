import { sendWhatsAppMessage } from "../../gateway/sendMessage.js";
import { withTenant } from "../../shared/db/index.js";

export type EscalationReason =
  "compatibilidad_tecnica" | "monto_alto" | "solicitud_cliente" | "intentos_fallidos" | "queja";

export interface EscalarHumanoInput {
  reason: EscalationReason;
  summary: string;
}

export interface EscalarHumanoOutput {
  handoff_id: string;
  status: "queued";
  assigned_to: string | null;
}

function buildNotificationText(reason: EscalationReason, summary: string): string {
  // Sin enlace a la vista del asesor todavía (ver
  // docs/fase-7-escalamiento-humano/vista-asesor.md) — esa vista es un
  // incremento de código separado; se agrega la línea del enlace cuando
  // exista una URL real que ofrecer.
  return `🔔 Conversación escalada — ForMotos\nMotivo: ${reason}\nResumen: ${summary}`;
}

/**
 * Tool escalar_a_humano (ver docs/fase-1-arquitectura/contratos-tools.md
 * y docs/fase-7-escalamiento-humano/handoff-queue.md). La decisión de
 * *cuándo* llamarla es del orchestrator (reglas explícitas) o de Claude
 * bajo su propio criterio para los motivos que lo ameritan — aquí solo se
 * registra en `handoff_queue` y se notifica al primer asesor activo del
 * tenant reutilizando WhatsApp (sin herramienta de soporte dedicada, ver
 * handoff-queue.md). Asignar un asesor específico al tomar el caso es
 * responsabilidad de la vista del asesor (incremento separado), no de
 * esta función.
 */
export async function escalarHumano(
  tenantId: string,
  conversationId: string,
  input: EscalarHumanoInput,
): Promise<EscalarHumanoOutput> {
  const { handoffId, agentContact } = await withTenant(tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO handoff_queue (tenant_id, conversation_id, reason, status, summary)
       VALUES ($1, $2, $3, 'queued', $4)
       RETURNING id`,
      [tenantId, conversationId, input.reason, input.summary],
    );
    const agent = await client.query<{ contact: string }>(
      `SELECT contact FROM human_agents WHERE active = true LIMIT 1`,
    );
    return { handoffId: result.rows[0]!.id, agentContact: agent.rows[0]?.contact ?? null };
  });

  if (agentContact) {
    try {
      await sendWhatsAppMessage(agentContact, buildNotificationText(input.reason, input.summary));
    } catch (error) {
      // La notificación es best-effort: el caso ya quedó registrado en
      // handoff_queue y el asesor puede revisarlo aunque el aviso
      // proactivo falle (ej. sin cuenta real de Twilio en desarrollo).
      console.error(`No se pudo notificar al asesor del escalamiento ${handoffId}`, error);
    }
  }

  return { handoff_id: handoffId, status: "queued", assigned_to: null };
}
