import { resolveHandoffToken } from "../shared/db/index.js";
import { withTenant } from "../shared/db/withTenant.js";

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

interface MessageRow {
  direction: "inbound" | "outbound";
  sender_type: "customer" | "agent" | "human";
  content: string;
  tool_calls: unknown | null;
  created_at: string;
}

function escapeHtml(value: string): string {
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

function renderMessageBody(row: MessageRow): string {
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

function renderPage(
  token: string,
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

  const actionHtml =
    handoff.status === "queued"
      ? `<form method="POST" action="/asesor/${token}/tomar"><button type="submit">Tomar conversación</button></form>`
      : handoff.status === "en_atencion"
        ? `<form method="POST" action="/asesor/${token}/resolver"><button type="submit">Marcar como resuelto</button></form>`
        : "";

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
    button { padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Conversación escalada — ForMotos</h1>
  <p><strong>Motivo:</strong> ${escapeHtml(handoff.reason)}<br>
     <strong>Estado:</strong> ${escapeHtml(handoff.status)}<br>
     <strong>Cliente:</strong> ${escapeHtml(customer.phone_number)}${customer.name ? ` (${escapeHtml(customer.name)})` : ""}</p>
  <p><strong>Resumen:</strong> ${escapeHtml(handoff.summary ?? "")}</p>
  <p><strong>Estado del flujo comercial:</strong> ${escapeHtml(JSON.stringify(conversation.state))}</p>
  ${actionHtml}
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
 * Vista mínima de solo lectura del asesor (ver
 * docs/fase-7-escalamiento-humano/vista-asesor.md): datos del cliente,
 * motivo + resumen del escalamiento, historial completo (incluye qué
 * tools se ejecutaron), estado estructurado y el botón de acción
 * correspondiente al estado actual del caso.
 */
export async function renderHandoffView(token: string): Promise<HandoffViewResult> {
  const lookup = await resolveHandoffToken(token);
  if (!lookup) {
    return { status: 404 };
  }

  const data = await withTenant(lookup.tenantId, async (client) => {
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
    html: renderPage(token, data.handoff, data.conversation, data.customer, data.messages),
  };
}

export interface HandoffActionResult {
  status: number;
}

/**
 * "Tomar conversación" (ver vista-asesor.md): pasa `handoff_queue.status`
 * a `en_atencion` y asigna al asesor dueño del enlace (`human_agent_id`
 * del token, ver handoffTokenDirectory.ts) — no hay sistema de login, el
 * enlace único ya identifica implícitamente a quién se le notificó.
 */
export async function tomarConversacion(token: string): Promise<HandoffActionResult> {
  const lookup = await resolveHandoffToken(token);
  if (!lookup) {
    return { status: 404 };
  }

  const updated = await withTenant(lookup.tenantId, async (client) => {
    const result = await client.query(
      `UPDATE handoff_queue SET status = 'en_atencion', assigned_to = $1
       WHERE id = $2 AND status = 'queued'
       RETURNING id`,
      [lookup.humanAgentId, lookup.handoffId],
    );
    return result.rows.length > 0;
  });

  return { status: updated ? 200 : 409 };
}

/**
 * Cierre del caso (ver docs/fase-7-escalamiento-humano/handoff-queue.md,
 * "reasignación y cierre"): la conversación NO vuelve automáticamente al
 * agente — sigue en `conversations.state.step = "escalado"` para siempre,
 * un mensaje nuevo del cliente más adelante abre una conversación nueva.
 */
export async function resolverConversacion(token: string): Promise<HandoffActionResult> {
  const lookup = await resolveHandoffToken(token);
  if (!lookup) {
    return { status: 404 };
  }

  const updated = await withTenant(lookup.tenantId, async (client) => {
    const result = await client.query(
      `UPDATE handoff_queue SET status = 'resuelto', resolved_at = now()
       WHERE id = $1 AND status = 'en_atencion'
       RETURNING id`,
      [lookup.handoffId],
    );
    return result.rows.length > 0;
  });

  return { status: updated ? 200 : 409 };
}
