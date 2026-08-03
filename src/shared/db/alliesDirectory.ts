import { withTransaction } from "./withTransaction.js";

/**
 * Aliados (proveedores externos, ej. "Ramos") — Fase 14, ver
 * docs/fase-14-catalogo-extendido/adrs/ADR-026-*.md. Todo producto tiene un
 * `ally_id` obligatorio; el aliado genérico ("Catálogo propio", sembrado en
 * la migración 0039) cubre los productos propios de ForMotos sin proveedor
 * externo — nunca hay que distinguir "con aliado"/"sin aliado" en el
 * código de promociones (Fase 17).
 */
export interface AllyRecord {
  id: string;
  name: string;
  contactInfo: string | null;
  active: boolean;
  createdAt: Date;
}

interface AllyRow {
  id: string;
  name: string;
  contact_info: string | null;
  active: boolean;
  created_at: Date;
}

function mapAllyRow(row: AllyRow): AllyRecord {
  return {
    id: row.id,
    name: row.name,
    contactInfo: row.contact_info,
    active: row.active,
    createdAt: row.created_at,
  };
}

export async function listAllies(): Promise<AllyRecord[]> {
  return withTransaction(async (client) => {
    const result = await client.query<AllyRow>(
      `SELECT id, name, contact_info, active, created_at FROM allies ORDER BY created_at`,
    );
    return result.rows.map(mapAllyRow);
  });
}

export async function createAlly(name: string, contactInfo: string | null): Promise<string> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO allies (name, contact_info) VALUES ($1, $2) RETURNING id`,
      [name, contactInfo],
    );
    return result.rows[0]!.id;
  });
}

export async function updateAlly(
  allyId: string,
  input: { name: string; contactInfo: string | null },
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`UPDATE allies SET name = $1, contact_info = $2 WHERE id = $3`, [
      input.name,
      input.contactInfo,
      allyId,
    ]);
  });
}

export async function setAllyActive(allyId: string, active: boolean): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`UPDATE allies SET active = $1 WHERE id = $2`, [active, allyId]);
  });
}
