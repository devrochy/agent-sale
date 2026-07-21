import type { PoolClient } from "pg";
import { pool } from "./pool.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Único punto de acceso a Postgres para los dominios (ver
 * docs/fase-2-fundaciones/multi-tenant-rls.md). Abre una transacción, fija
 * `app.tenant_id` para esa transacción vía `set_config` (parametrizado, no
 * interpolación de string) y hace commit/rollback automático. Ningún
 * dominio abre su propia conexión ni pasa `tenant_id` a mano en una query.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new Error(`tenantId inválido: ${tenantId}`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
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
