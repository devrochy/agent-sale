import { Redis } from "ioredis";
import { env } from "../../config/env.js";
import { requiresTls } from "../tlsPolicy.js";

// Instancia única compartida (mismo patrón que shared/db/pool.ts): la usan
// gateway (idempotencia + cola), y más adelante domains/catalog (cache) y
// orchestrator.
export const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: 3,
  tls: requiresTls(env.redisUrl) ? {} : undefined,
});
