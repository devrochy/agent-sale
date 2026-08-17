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
 * Encuentra o crea el customer y la conversación abierta para una **dirección
 * de canal** (ver docs/fase-4-motor-agente/memoria-conversacional.md).
 * Expone `customerId` además de `conversationId` porque las tools del
 * dominio comercial (generar_cotizacion) necesitan asociar la cotización
 * al cliente, no solo a la conversación.
 *
 * Identidad (Fase 19, Etapa C1): el cliente es `(channel, external_id)`, no un
 * teléfono. El mismo humano escribiendo por WhatsApp y por Instagram son dos
 * filas de `customers` y dos hilos, a propósito: Meta no da forma de saber que
 * son la misma persona, y contestarle por el canal equivocado es peor que
 * tratarlo como dos. Lo que sí se comparte, cuando el teléfono coincide, son
 * los datos de gestión del pedido (ver `contact_phone`).
 *
 * Dentro de un mismo canal la búsqueda **no** filtra por conexión: si el
 * cliente venía por el número de Twilio y ahora escribe al de Meta, sigue
 * siendo el mismo hilo (decisión de la Etapa B).
 */
export async function resolveConversation(
  customerExternalId: string,
  customerName?: string,
  origin?: InboundOrigin,
): Promise<ResolvedConversation> {
  const channel: Channel = origin?.channel ?? "whatsapp";
  return withTransaction(async (client) => {
    // `ProfileName` de Twilio (ver webhook-contrato.md) llega en cada
    // mensaje, no solo en el primero — COALESCE conserva el nombre ya
    // guardado si un mensaje puntual llega sin él, y lo actualiza cuando
    // sí llega (ej. el cliente cambió su nombre de perfil de WhatsApp).
    const customer = await client.query<{ id: string; bot_paused: boolean }>(
      // En WhatsApp la dirección del canal *es* el teléfono, así que
      // `contact_phone` sale gratis. En Instagram/Messenger queda null hasta
      // que el cliente lo dé al comprar. Solo se escribe al insertar: si el
      // cliente ya dio un teléfono distinto, manda el suyo.
      //
      // El `LIKE 'whatsapp:+%'` no es defensivo de más: es la misma guarda que
      // el backfill de la migración 0054, y sin ella una dirección sin el
      // prefijo canónico se copiaría tal cual como si fuera un teléfono,
      // creando un cruce falso con otro cliente que sí lo tenga.
      `INSERT INTO customers (channel, external_id, name, contact_phone)
       VALUES ($1, $2, $3,
               CASE WHEN $1 = 'whatsapp' AND $2 LIKE 'whatsapp:+%'
                    THEN replace($2, 'whatsapp:', '') END)
       ON CONFLICT (channel, external_id) DO UPDATE SET
         external_id = EXCLUDED.external_id,
         name = COALESCE(EXCLUDED.name, customers.name)
       RETURNING id, bot_paused`,
      [channel, customerExternalId, customerName ?? null],
    );
    const customerId = customer.rows[0]!.id;
    const customerBotPaused = customer.rows[0]!.bot_paused;

    const existing = await client.query<{
      id: string;
      state: Record<string, unknown>;
      bot_paused: boolean;
      connection_id: string | null;
    }>(
      `SELECT id, state, bot_paused, connection_id FROM conversations
       WHERE customer_id = $1 AND status = 'open'
       ORDER BY started_at DESC LIMIT 1`,
      [customerId],
    );
    if (existing.rows[0]) {
      // La conversación sigue al último número usado (Fase 19, Etapa B): si el
      // cliente venía escribiendo al número de Twilio y ahora escribe al de
      // Meta, es el mismo hilo —conserva carrito, historial y estado de
      // pedido— pero la respuesta tiene que salir por donde escribió recién.
      // Sin este UPDATE le contestaríamos desde un número que no contactó, lo
      // que abre una ventana de 24 h nueva y el proveedor la rechaza.
      // Desde la Etapa C1 el salto solo puede ser **entre proveedores del
      // mismo canal**: el cliente está indexado por canal, así que un mensaje
      // de Instagram nunca cae en esta conversación de WhatsApp.
      if (origin?.connectionId && origin.connectionId !== existing.rows[0].connection_id) {
        await client.query(
          `UPDATE conversations SET connection_id = $1, channel = $2 WHERE id = $3`,
          [origin.connectionId, channel, existing.rows[0].id],
        );
      }
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
       VALUES ($1, 'open', '{}'::jsonb, $2, $3)
       RETURNING id, state, bot_paused`,
      [customerId, channel, origin?.connectionId ?? null],
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
