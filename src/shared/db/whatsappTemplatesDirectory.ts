import { withTransaction } from "./withTransaction.js";

/**
 * CRUD de plantillas de mensajes de Meta para el panel admin (ver
 * migrations/0057_whatsapp_templates.cjs). Cada fila refleja el estado de
 * una plantilla que ya se mandó a revisión — no hay estado "borrador, sin
 * enviar a Meta": eso lo hace `crearPlantilla` en adminPanel.ts, que llama a
 * `createTemplate` (Graph API) y a `createTemplateRecord` en el mismo paso.
 *
 * `hello_world` no tiene fila acá: es la plantilla de ejemplo que trae
 * cualquier WABA, ya aprobada — el panel la muestra como fila sintética.
 */

export type TemplateCategory = "UTILITY" | "MARKETING" | "AUTHENTICATION";
export type TemplateStatus =
  | "pending"
  | "in_review"
  | "approved"
  | "rejected"
  | "paused"
  | "disabled";

/** Un componente tal cual lo exige la Graph API — no se tipa más fino a propósito: es el mismo objeto que se manda a Meta sin transformar. */
export type TemplateComponent = Record<string, unknown>;

export interface WhatsAppTemplateRecord {
  id: string;
  connectionId: string;
  name: string;
  category: TemplateCategory;
  language: string;
  components: TemplateComponent[];
  status: TemplateStatus;
  externalTemplateId: string | null;
  rejectionReason: string | null;
  createdByAdminId: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TemplateRow {
  id: string;
  connection_id: string;
  name: string;
  category: TemplateCategory;
  language: string;
  components: TemplateComponent[];
  status: TemplateStatus;
  external_template_id: string | null;
  rejection_reason: string | null;
  created_by_admin_id: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "id, connection_id, name, category, language, components, status, external_template_id, rejection_reason, created_by_admin_id, last_synced_at, created_at, updated_at";

function mapRow(row: TemplateRow): WhatsAppTemplateRecord {
  return {
    id: row.id,
    connectionId: row.connection_id,
    name: row.name,
    category: row.category,
    language: row.language,
    components: row.components,
    status: row.status,
    externalTemplateId: row.external_template_id,
    rejectionReason: row.rejection_reason,
    createdByAdminId: row.created_by_admin_id,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listTemplates(connectionId?: string): Promise<WhatsAppTemplateRecord[]> {
  return withTransaction(async (client) => {
    const result = connectionId
      ? await client.query<TemplateRow>(
          `SELECT ${COLUMNS} FROM whatsapp_templates WHERE connection_id = $1 ORDER BY created_at DESC`,
          [connectionId],
        )
      : await client.query<TemplateRow>(
          `SELECT ${COLUMNS} FROM whatsapp_templates ORDER BY created_at DESC`,
        );
    return result.rows.map(mapRow);
  });
}

export async function getTemplate(id: string): Promise<WhatsAppTemplateRecord | null> {
  return withTransaction(async (client) => {
    const result = await client.query<TemplateRow>(
      `SELECT ${COLUMNS} FROM whatsapp_templates WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  });
}

export interface CreateTemplateInput {
  connectionId: string;
  name: string;
  category: TemplateCategory;
  language: string;
  components: TemplateComponent[];
  createdByAdminId: string;
}

export async function createTemplateRecord(input: CreateTemplateInput): Promise<string> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO whatsapp_templates
         (connection_id, name, category, language, components, created_by_admin_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.connectionId,
        input.name,
        input.category,
        input.language,
        JSON.stringify(input.components),
        input.createdByAdminId,
      ],
    );
    return result.rows[0]!.id;
  });
}

/** Persiste el id externo y el status que devolvió Meta justo después del POST de creación. */
export async function markTemplateSubmitted(
  id: string,
  externalTemplateId: string,
  status: TemplateStatus,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE whatsapp_templates
       SET external_template_id = $2, status = $3, last_synced_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, externalTemplateId, status],
    );
  });
}

/** Usado por "Sincronizar" — refresca el status real contra Meta. */
export async function updateTemplateStatus(
  id: string,
  status: TemplateStatus,
  rejectionReason: string | null,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE whatsapp_templates
       SET status = $2, rejection_reason = $3, last_synced_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, status, rejectionReason],
    );
  });
}

export async function deleteTemplateRecord(id: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM whatsapp_templates WHERE id = $1`, [id]);
  });
}
