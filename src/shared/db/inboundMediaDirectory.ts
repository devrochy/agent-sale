import { withTransaction } from "./withTransaction.js";

/**
 * Medios entrantes de WhatsApp (imagen/audio) — ver migración 0060 y el
 * docblock de `gateway/channels/meta/media.ts`. Genérica a propósito: la
 * usan el comprobante de transferencia (Fase 1), y más adelante audio
 * (Fase 2) y búsqueda por foto (Fase 3) — nadie es dueño de esta tabla.
 *
 * `data_base64` inline en Postgres, no un storage de objetos (ver el
 * comentario de la migración 0037: no hay uno en el proyecto todavía).
 */

export type InboundMediaKind = "image" | "audio";

export interface GuardarMediaEntranteInput {
  conversationId: string;
  kind: InboundMediaKind;
  mimeType: string;
  buffer: Buffer;
}

export async function guardarMediaEntrante(input: GuardarMediaEntranteInput): Promise<string> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO inbound_media (conversation_id, kind, mime_type, data_base64)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [input.conversationId, input.kind, input.mimeType, input.buffer.toString("base64")],
    );
    return result.rows[0]!.id;
  });
}

export interface InboundMediaRecord {
  id: string;
  conversationId: string;
  kind: InboundMediaKind;
  mimeType: string;
  buffer: Buffer;
  createdAt: string;
}

/** Usado por el panel para mostrar la imagen del comprobante (`src/admin/adminPanel.ts`). */
export async function getInboundMedia(id: string): Promise<InboundMediaRecord | null> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      conversation_id: string;
      kind: InboundMediaKind;
      mime_type: string;
      data_base64: string;
      created_at: string;
    }>(
      `SELECT id, conversation_id, kind, mime_type, data_base64, created_at FROM inbound_media WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      conversationId: row.conversation_id,
      kind: row.kind,
      mimeType: row.mime_type,
      buffer: Buffer.from(row.data_base64, "base64"),
      createdAt: row.created_at,
    };
  });
}
