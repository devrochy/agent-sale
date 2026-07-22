import { env } from "../../config/env.js";
import { sendWhatsAppMessage } from "../../gateway/sendMessage.js";
import { createHandoffToken, withTenant } from "../../shared/db/index.js";

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

/**
 * `PUBLIC_WEBHOOK_URL` ya es el origen público real donde corre este
 * mismo proceso Fastify (ver src/config/env.ts) — se reutiliza para armar
 * el link a la vista del asesor en vez de agregar una variable de entorno
 * nueva solo para esto.
 */
function buildAdvisorLink(token: string): string {
  return `${new URL(env.publicWebhookUrl).origin}/asesor/${token}`;
}

function buildNotificationText(
  reason: EscalationReason,
  summary: string,
  advisorLink: string,
): string {
  return `🔔 Conversación escalada — ForMotos\nMotivo: ${reason}\nResumen: ${summary}\nVer conversación: ${advisorLink}`;
}

/**
 * Tool escalar_a_humano (ver docs/fase-1-arquitectura/contratos-tools.md,
 * docs/fase-7-escalamiento-humano/handoff-queue.md y vista-asesor.md). La
 * decisión de *cuándo* llamarla es del orchestrator (reglas explícitas) o
 * de Claude bajo su propio criterio para los motivos que lo ameritan —
 * aquí se registra en `handoff_queue`, se genera el enlace único de la
 * vista del asesor (ver src/advisor/) y se notifica al primer asesor
 * activo del tenant reutilizando WhatsApp (sin herramienta de soporte
 * dedicada, ver handoff-queue.md). El token queda atado a ese asesor
 * (`human_agent_id`) para que "Tomar conversación" pueda asignarlo sin
 * necesitar un sistema de login (ver vista-asesor.md).
 */
export async function escalarHumano(
  tenantId: string,
  conversationId: string,
  input: EscalarHumanoInput,
): Promise<EscalarHumanoOutput> {
  const { handoffId, agent } = await withTenant(tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO handoff_queue (tenant_id, conversation_id, reason, status, summary)
       VALUES ($1, $2, $3, 'queued', $4)
       RETURNING id`,
      [tenantId, conversationId, input.reason, input.summary],
    );
    const agentResult = await client.query<{ id: string; contact: string }>(
      `SELECT id, contact FROM human_agents WHERE active = true LIMIT 1`,
    );
    return { handoffId: result.rows[0]!.id, agent: agentResult.rows[0] ?? null };
  });

  const token = await createHandoffToken(tenantId, handoffId, agent?.id ?? null);

  if (agent) {
    try {
      const advisorLink = buildAdvisorLink(token);
      await sendWhatsAppMessage(
        agent.contact,
        buildNotificationText(input.reason, input.summary, advisorLink),
      );
    } catch (error) {
      // La notificación es best-effort: el caso ya quedó registrado en
      // handoff_queue y el asesor puede revisarlo aunque el aviso
      // proactivo falle (ej. sin cuenta real de Twilio en desarrollo).
      console.error(`No se pudo notificar al asesor del escalamiento ${handoffId}`, error);
    }
  }

  return { handoff_id: handoffId, status: "queued", assigned_to: null };
}
