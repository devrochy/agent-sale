import { withTenant } from "../shared/db/index.js";
import type { LLMMessage } from "./llm/types.js";

export interface ResolvedConversation {
  conversationId: string;
  state: Record<string, unknown>;
}

/**
 * Encuentra o crea el customer y la conversación abierta para un
 * teléfono (ver docs/fase-4-motor-agente/memoria-conversacional.md).
 */
export async function resolveConversation(
  tenantId: string,
  customerPhone: string,
): Promise<ResolvedConversation> {
  return withTenant(tenantId, async (client) => {
    const customer = await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, phone_number)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id, phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
       RETURNING id`,
      [tenantId, customerPhone],
    );
    const customerId = customer.rows[0]!.id;

    const existing = await client.query<{ id: string; state: Record<string, unknown> }>(
      `SELECT id, state FROM conversations
       WHERE tenant_id = $1 AND customer_id = $2 AND status = 'open'
       ORDER BY started_at DESC LIMIT 1`,
      [tenantId, customerId],
    );
    if (existing.rows[0]) {
      return { conversationId: existing.rows[0].id, state: existing.rows[0].state };
    }

    const created = await client.query<{ id: string; state: Record<string, unknown> }>(
      `INSERT INTO conversations (tenant_id, customer_id, status, state)
       VALUES ($1, $2, 'open', '{}'::jsonb)
       RETURNING id, state`,
      [tenantId, customerId],
    );
    return { conversationId: created.rows[0]!.id, state: created.rows[0]!.state };
  });
}

interface MessageRow {
  direction: "inbound" | "outbound";
  sender_type: "customer" | "agent" | "human";
  content: string;
  tool_calls: unknown | null;
}

/**
 * Reconstruye el historial como MessageParam[] para enviarlo en cada
 * llamada a Claude (la API es stateless). Si `tool_calls` tiene el array
 * completo de content blocks (tool_use/tool_result), se usa tal cual;
 * si no, el mensaje era texto plano. `tool_calls` se guarda como jsonb
 * genérico a propósito — cruza el límite de la base de datos, así que no
 * vale la pena forzar un tipo estático estricto en el round-trip.
 */
export async function loadHistory(
  tenantId: string,
  conversationId: string,
): Promise<LLMMessage[]> {
  const rows = await withTenant(tenantId, async (client) => {
    const result = await client.query<MessageRow>(
      `SELECT direction, sender_type, content, tool_calls
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId],
    );
    return result.rows;
  });

  return rows.map((row) => ({
    role: row.direction === "inbound" ? "user" : "assistant",
    content: (row.tool_calls ?? row.content) as LLMMessage["content"],
  }));
}

export async function appendMessage(
  tenantId: string,
  conversationId: string,
  direction: "inbound" | "outbound",
  senderType: "customer" | "agent" | "human",
  content: string,
  toolCalls?: unknown,
): Promise<void> {
  await withTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content, tool_calls)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        tenantId,
        conversationId,
        direction,
        senderType,
        content,
        toolCalls ? JSON.stringify(toolCalls) : null,
      ],
    ),
  );
}

export async function updateState(
  tenantId: string,
  conversationId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await withTenant(tenantId, (client) =>
    client.query(
      `UPDATE conversations SET state = state || $1::jsonb WHERE id = $2`,
      [JSON.stringify(patch), conversationId],
    ),
  );
}
