import pg from "pg";
import { env } from "../../config/env.js";

const { Pool } = pg;

// TLS forzado a cualquier host que no sea local (ver
// docs/fase-8-observabilidad-seguridad/revision-seguridad.md, "TLS en
// todas las conexiones") — Supabase u otro Postgres gestionado, sin
// depender de que la cadena de conexión ya traiga `sslmode=require` ni de
// que alguien recuerde setear NODE_ENV=production (fly.toml no lo define).
const isLocalHost = ["localhost", "127.0.0.1"].includes(new URL(env.databaseUrl).hostname);

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: isLocalHost ? undefined : { rejectUnauthorized: true },
});

export type { PoolClient } from "pg";
