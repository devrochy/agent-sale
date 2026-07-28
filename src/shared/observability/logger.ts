import pino from "pino";
import { env } from "../../config/env.js";

/**
 * Instancia única de logging estructurado (ver
 * docs/fase-8-observabilidad-seguridad/tracing.md y ADR-009). Cada módulo
 * que ya tenga `tenant_id`/`conversation_id` en scope hace
 * `logger.child({ tenant_id, conversation_id })` en vez de recibir un
 * logger por parámetro — evita tocar firmas de funciones existentes solo
 * para instrumentar. Emite JSON a stdout: es lo que un agente de reenvío
 * (Fly.io → Grafana Cloud/Loki) consume, sin transporte propio en el código.
 */
export const logger = pino({
  level: env.logLevel,
});
