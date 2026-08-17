import { resolveNotificationRecipients } from "../../admin/auth/adminsDirectory.js";
import { env } from "../../config/env.js";
import { sendWhatsAppMessage } from "../../gateway/sendMessage.js";
import { createHandoffToken, getReportRecipient, withTransaction } from "../../shared/db/index.js";
import { logger } from "../../shared/observability/logger.js";

// "guardrail_precio" y "fuera_de_alcance" se agregaron en la Fase 8
// (código, ver migrations/0016_escalation_reasons_fase8.cjs y
// docs/fase-8-observabilidad-seguridad/guardrails.md). "guardrail_precio"
// es interno: nunca lo elige el LLM (no está en el enum de la tool
// escalar_a_humano de toolDefinitions.ts), solo lo dispara el orquestador.
// "guardrail_stock" se agregó en la Fase 12.1 (migrations/0019), mismo
// criterio: interno, extiende el guardrail de precios a disponibilidad
// (ver docs/fase-12-capacidades-proactivas-agente/analisis-superpoderes.md).
export type EscalationReason =
  | "compatibilidad_tecnica"
  | "monto_alto"
  | "solicitud_cliente"
  | "intentos_fallidos"
  | "queja"
  | "guardrail_precio"
  | "fuera_de_alcance"
  | "guardrail_stock";

export interface EscalarHumanoInput {
  reason: EscalationReason;
  summary: string;
}

export interface EscalarHumanoOutput {
  handoff_id: string;
  status: "queued";
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
 * aquí se registra en `handoff_queue`, se genera el enlace único de solo
 * lectura de la vista del asesor (ver src/advisor/ y ADR-028, Fase 18) y
 * se notifica por WhatsApp a los administradores con
 * `admin_permissions.recibe_tickets` marcado (Fase 13/18, ver
 * `resolveNotificationRecipients` en adminsDirectory.ts — mismo mecanismo
 * que el reporte diario y las notificaciones de pago). Tomar/resolver el
 * ticket vive exclusivamente en el panel autenticado, no en este flujo.
 */
export async function escalarHumano(
  conversationId: string,
  input: EscalarHumanoInput,
): Promise<EscalarHumanoOutput> {
  const handoffId = await withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO handoff_queue (conversation_id, reason, status, summary)
       VALUES ($1, $2, 'queued', $3)
       RETURNING id`,
      [conversationId, input.reason, input.summary],
    );
    return result.rows[0]!.id;
  });

  const token = await createHandoffToken(handoffId);

  const fallbackPhone = await getReportRecipient();
  const recipients = await resolveNotificationRecipients("recibeTickets", fallbackPhone);
  if (recipients.length > 0) {
    const advisorLink = buildAdvisorLink(token);
    const text = buildNotificationText(input.reason, input.summary, advisorLink);
    for (const recipient of recipients) {
      try {
        await sendWhatsAppMessage(recipient, text);
      } catch (error) {
        // La notificación es best-effort, por destinatario: el caso ya
        // quedó registrado en handoff_queue y cualquier admin puede
        // revisarlo en el panel aunque el aviso proactivo falle para
        // alguno (ej. sin cuenta real de Twilio en desarrollo).
        logger
          .child({ conversation_id: conversationId })
          .warn({ error, handoff_id: handoffId }, "No se pudo notificar al asesor del escalamiento");
      }
    }
  }

  return { handoff_id: handoffId, status: "queued" };
}
