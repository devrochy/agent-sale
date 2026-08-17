import { resolveHandoffToken } from "../shared/db/index.js";
import { withTransaction } from "../shared/db/withTransaction.js";

interface HandoffRow {
  reason: string;
  status: string;
  summary: string | null;
  created_at: string;
  resolved_at: string | null;
  conversation_id: string;
}

interface ConversationRow {
  customer_id: string;
  state: Record<string, unknown>;
}

interface CustomerRow {
  phone_number: string;
  name: string | null;
}

export interface MessageRow {
  direction: "inbound" | "outbound";
  sender_type: "customer" | "agent" | "human";
  content: string;
  tool_calls: unknown | null;
  created_at: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; content: string; is_error?: boolean };

/**
 * Reusada por el panel admin para el inbox de conversaciones (ver
 * docs/fase-11-panel-admin-dashboard/conversaciones-leads-tickets.md) —
 * misma lógica de "qué tool se ejecutó en cada turno" que ya usaba la
 * vista del asesor, sin duplicarla.
 */
export function renderMessageBody(row: MessageRow): string {
  if (!row.tool_calls) {
    return escapeHtml(row.content);
  }
  const blocks = row.tool_calls as ToolContentBlock[];
  return blocks
    .map((block) => {
      if (block.type === "text") {
        return escapeHtml(block.text);
      }
      if (block.type === "tool_use") {
        return `<em>[tool: ${escapeHtml(block.name)} — ${escapeHtml(JSON.stringify(block.input))}]</em>`;
      }
      if (block.type === "tool_result") {
        return `<em>[resultado${block.is_error ? " (error)" : ""}: ${escapeHtml(block.content)}]</em>`;
      }
      return "";
    })
    .join("<br>");
}

// Labels legibles del paso del flujo comercial (ver
// src/orchestrator/*, `conversations.state.step`) — reemplaza el
// `JSON.stringify(conversation.state)` crudo que mostraba esta vista
// (Fase 18, DoD #2). Un paso no mapeado (o ausente) simplemente no
// muestra la línea, no es un error.
const FLOW_STEP_LABEL: Record<string, string> = {
  escalado: "Escalada a un humano",
  cotizando: "Cotizando",
  confirmando_pedido: "Confirmando pedido",
  esperando_pago: "Esperando pago",
};

function renderPage(
  handoff: HandoffRow,
  conversation: ConversationRow,
  customer: CustomerRow,
  messages: MessageRow[],
): string {
  const messagesHtml = messages
    .map(
      (row) => `
      <div class="msg ${row.direction}">
        <span class="meta">${escapeHtml(row.sender_type)} · ${escapeHtml(String(row.created_at))}</span>
        <div class="body">${renderMessageBody(row)}</div>
      </div>`,
    )
    .join("\n");

  const step = typeof conversation.state.step === "string" ? conversation.state.step : null;
  const stepLabel = step ? (FLOW_STEP_LABEL[step] ?? step) : null;

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>ForMotos — Conversación escalada</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    .msg { margin-bottom: 0.75rem; padding: 0.5rem 0.75rem; border-radius: 6px; }
    .msg.inbound { background: #f0f0f0; }
    .msg.outbound { background: #e6f0ff; }
    .meta { font-size: 0.75rem; color: #666; }
    a.button { display: inline-block; padding: 0.5rem 1rem; font-size: 1rem; text-decoration: none; background: #1a1a1a; color: #fff; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>Conversación escalada — ForMotos</h1>
  <p><strong>Motivo:</strong> ${escapeHtml(handoff.reason)}<br>
     <strong>Estado:</strong> ${escapeHtml(handoff.status)}<br>
     <strong>Cliente:</strong> ${escapeHtml(customer.phone_number)}${customer.name ? ` (${escapeHtml(customer.name)})` : ""}</p>
  <p><strong>Resumen:</strong> ${escapeHtml(handoff.summary ?? "")}</p>
  ${stepLabel ? `<p><strong>Paso del flujo comercial:</strong> ${escapeHtml(stepLabel)}</p>` : ""}
  <p><a class="button" href="/admin/conversaciones?estado=escaladas&c=${handoff.conversation_id}">Ver y actuar en el panel →</a></p>
  <h2>Historial de la conversación</h2>
  ${messagesHtml}
</body>
</html>`;
}

export interface HandoffViewResult {
  status: number;
  html?: string;
}

/**
 * Vista de solo lectura del asesor (ver docs/fase-7-escalamiento-humano/
 * vista-asesor.md y ADR-028, Fase 18): datos del cliente, motivo +
 * resumen del escalamiento, historial completo (incluye qué tools se
 * ejecutaron) y el paso del flujo comercial en texto legible. Tomar y
 * resolver el ticket ya no ocurre acá — el enlace solo da contexto y
 * dirige al panel autenticado (`/admin/conversaciones`).
 */
export async function renderHandoffView(token: string): Promise<HandoffViewResult> {
  const lookup = await resolveHandoffToken(token);
  if (!lookup) {
    return { status: 404 };
  }

  const data = await withTransaction(async (client) => {
    const handoffResult = await client.query<HandoffRow>(
      `SELECT reason, status, summary, created_at, resolved_at, conversation_id
       FROM handoff_queue WHERE id = $1`,
      [lookup.handoffId],
    );
    const handoff = handoffResult.rows[0];
    if (!handoff) {
      return null;
    }

    const conversationResult = await client.query<ConversationRow>(
      `SELECT customer_id, state FROM conversations WHERE id = $1`,
      [handoff.conversation_id],
    );
    const conversation = conversationResult.rows[0]!;

    const customerResult = await client.query<CustomerRow>(
      `SELECT phone_number, name FROM customers WHERE id = $1`,
      [conversation.customer_id],
    );
    const customer = customerResult.rows[0]!;

    const messagesResult = await client.query<MessageRow>(
      `SELECT direction, sender_type, content, tool_calls, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [handoff.conversation_id],
    );

    return { handoff, conversation, customer, messages: messagesResult.rows };
  });

  if (!data) {
    return { status: 404 };
  }

  return {
    status: 200,
    html: renderPage(data.handoff, data.conversation, data.customer, data.messages),
  };
}
