import pg from "pg";
import { env } from "../../config/env.js";
import { requiresTls } from "../tlsPolicy.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: requiresTls(env.databaseUrl) ? { rejectUnauthorized: true } : undefined,
  // Sin esto, una query colgada (Postgres bloqueado, red caída a mitad de
  // una consulta) retiene su conexión del pool indefinidamente — con
  // max=10 (default de `pg`), unas pocas queries así bastan para agotarlo
  // y dejar a TODO el proceso sin poder hablarle a Postgres, incluido
  // /healthz (ver Fase 3 del plan de remediación del incidente
  // 2026-09-13). `statement_timeout` corta la query en el server;
  // `connectionTimeoutMillis` cubre el otro lado, adquirir una conexión
  // del pool cuando está lleno.
  statement_timeout: env.pgStatementTimeoutMs,
  connectionTimeoutMillis: env.pgConnectionTimeoutMs,
});

export type { PoolClient } from "pg";
