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
  // PII fuera de logs (ver docs/fase-8-observabilidad-seguridad/revision-seguridad.md):
  // los puntos de log de esta app ya evitan por diseño loguear teléfono
  // completo o texto literal del mensaje (solo tenant_id/conversation_id
  // para correlación) — este redact es defensa en profundidad por si
  // algún campo así se agrega por error a futuro. El historial completo
  // de la conversación vive en Postgres con RLS, no en logs de terceros.
  redact: {
    paths: [
      "req.body",
      "customer_phone",
      "*.customer_phone",
      "body",
      "*.body",
      "to",
      "*.to",
      "from",
      "*.from",
    ],
    censor: "[REDACTED]",
  },
});
