import type { Channel } from "../shared/db/connectionsDirectory.js";
import { withTransaction } from "../shared/db/index.js";
import type { LLMMessage } from "./llm/types.js";

export interface ResolvedConversation {
  conversationId: string;
  customerId: string;
  state: Record<string, unknown>;
  customerBotPaused: boolean;
  conversationBotPaused: boolean;
}

/**
 * Por dónde entró el mensaje (Fase 19). Opcional: los caminos que todavía no
 * lo propagan, y las entradas de la cola escritas por un release anterior,
 * caen al default de `whatsapp` sin conexión, igual que antes.
 */
export interface InboundOrigin {
  connectionId?: string;
  channel?: Channel;
}

/**
 * Encuentra o crea el customer y la conversación abierta para un
 * teléfono (ver docs/fase-4-motor-agente/memoria-conversacional.md).
 * Expone `customerId` además de `conversationId` porque las tools del
 * dominio comercial (generar_cotizacion) necesitan asociar la cotización
 * al cliente, no solo a la conversación.
 *
 * La búsqueda de la conversación abierta sigue siendo por cliente, **no** por
 * conexión: mientras exista una sola conexión, filtrar por ella sería un
 * cambio de comportamiento sin beneficio observable y con riesgo real
 * (payloads de debounce en vuelo, conversaciones huérfanas, atribución de la
 * encuesta de satisfacción). Ese cambio va en la Etapa B, junto con la
 * decisión de producto sobre qué significa pausar un hilo cuando el mismo
 * humano escribe por dos conexiones.
 */
export async function resolveConversation(
  customerPhone: string,
  customerName?: string,
  origin?: InboundOrigin,
): Promise<ResolvedConversation> {
  return withTransaction(async (client) => {
    // `ProfileName` de Twilio (ver webhook-contrato.md) llega en cada
    // mensaje, no solo en el primero — COALESCE conserva el nombre ya
    // guardado si un mensaje puntual llega sin él, y lo actualiza cuando
    // sí llega (ej. el cliente cambió su nombre de perfil de WhatsApp).
    const customer = await client.query<{ id: string; bot_paused: boolean }>(
      `INSERT INTO customers (phone_number, name)
       VALUES ($1, $2)
       ON CONFLICT (phone_number) DO UPDATE SET
         phone_number = EXCLUDED.phone_number,
         name = COALESCE(EXCLUDED.name, customers.name)
       RETURNING id, bot_paused`,
      [customerPhone, customerName ?? null],
    );
    const customerId = customer.rows[0]!.id;
    const customerBotPaused = customer.rows[0]!.bot_paused;

    const existing = await client.query<{ id: string; state: Record<string, unknown>; bot_paused: boolean }>(
      `SELECT id, state, bot_paused FROM conversations
       WHERE customer_id = $1 AND status = 'open'
       ORDER BY started_at DESC LIMIT 1`,
      [customerId],
    );
    if (existing.rows[0]) {
      return {
        conversationId: existing.rows[0].id,
        customerId,
        state: existing.rows[0].state,
        customerBotPaused,
        conversationBotPaused: existing.rows[0].bot_paused,
      };
    }

    const created = await client.query<{ id: string; state: Record<string, unknown>; bot_paused: boolean }>(
      `INSERT INTO conversations (customer_id, status, state, channel, connection_id)
       VALUES ($1, 'open', '{}'::jsonb, COALESCE($2, 'whatsapp'), $3)
       RETURNING id, state, bot_paused`,
      [customerId, origin?.channel ?? null, origin?.connectionId ?? null],
    );
    return {
      conversationId: created.rows[0]!.id,
      customerId,
      state: created.rows[0]!.state,
      customerBotPaused,
      conversationBotPaused: created.rows[0]!.bot_paused,
    };
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
export async function loadHistory(conversationId: string): Promise<LLMMessage[]> {
  const rows = await withTransaction(async (client) => {
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

/** Devuelve el `id` de la fila insertada — ver updateMessageContent, que lo usa para corregir el texto mostrado sin tocar `tool_calls`. */
export async function appendMessage(
  conversationId: string,
  direction: "inbound" | "outbound",
  senderType: "customer" | "agent" | "human",
  content: string,
  toolCalls?: unknown,
): Promise<string> {
  const result = await withTransaction((client) =>
    client.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, direction, sender_type, content, tool_calls)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [conversationId, direction, senderType, content, toolCalls ? JSON.stringify(toolCalls) : null],
    ),
  );
  return result.rows[0]!.id;
}

/**
 * Corrige el `content` (columna de texto mostrado en el panel/vista del
 * asesor, ver renderMessageBody en handoffView.ts) de un mensaje ya
 * persistido, sin tocar `tool_calls` (los content blocks crudos que
 * loadHistory usa para reconstruir el contexto real que vio/generó el
 * LLM). Caso de uso: el link de pago de Wompi (ver loop.ts,
 * extractPaymentLinkUrl) se agrega al texto que realmente se manda por
 * WhatsApp *después* de que la respuesta del LLM ya quedó persistida —
 * sin esto, la transcripción del panel no coincidiría con lo que el
 * cliente recibió de verdad.
 */
export async function updateMessageContent(messageId: string, content: string): Promise<void> {
  await withTransaction((client) =>
    client.query(`UPDATE messages SET content = $1 WHERE id = $2`, [content, messageId]),
  );
}

export async function updateState(
  conversationId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await withTransaction((client) =>
    client.query(`UPDATE conversations SET state = state || $1::jsonb WHERE id = $2`, [
      JSON.stringify(patch),
      conversationId,
    ]),
  );
}
