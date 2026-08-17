import pg from "pg";
import { env } from "../../config/env.js";
import { requiresTls } from "../tlsPolicy.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: requiresTls(env.databaseUrl) ? { rejectUnauthorized: true } : undefined,
});

export type { PoolClient } from "pg";
