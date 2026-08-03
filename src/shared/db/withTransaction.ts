import type { PoolClient } from "pg";
import { pool } from "./pool.js";

/**
 * Único punto de acceso a Postgres para los dominios — abre una
 * transacción y hace commit/rollback automático, ningún dominio abre su
 * propia conexión. Antes (ver ADR-004, superada) también fijaba
 * `app.tenant_id` para Row Level Security; ADR-032 retiró multi-tenancy,
 * así que esto quedó en una transacción simple.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
