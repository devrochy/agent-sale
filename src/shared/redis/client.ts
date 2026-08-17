import { Redis } from "ioredis";
import { env } from "../../config/env.js";

// Instancia única compartida (mismo patrón que shared/db/pool.ts): la usan
// gateway (idempotencia + cola), y más adelante domains/catalog (cache) y
// orchestrator.
// TLS forzado a cualquier host que no sea local (ver
// docs/fase-8-observabilidad-seguridad/revision-seguridad.md, "TLS en
// todas las conexiones") — un Redis gestionado remoto, sin depender de
// que REDIS_URL use el esquema `rediss://`.
const isLocalHost = ["localhost", "127.0.0.1"].includes(new URL(env.redisUrl).hostname);

export const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: 3,
  tls: isLocalHost ? undefined : {},
});
