import pino from "pino";
import { env } from "../../config/env.js";

/**
 * Rutas cuyo token va en el path y es la única credencial: no hay login
 * detrás, quien tenga el enlace entra. El access log de Fastify serializa
 * `req.url` completo, así que sin esto el token del asesor o de la reseña
 * quedaría en claro en los logs (y en Loki, que es un tercero).
 *
 * No se ancla el final a propósito: `/asesor/:token/tomar` conserva el
 * sufijo, que es lo que permite distinguir la acción al depurar.
 */
const RUTAS_CON_TOKEN = /^\/(asesor|resena)\/[^/]+/;

/**
 * Parámetros de query secretos. `hub.verify_token` es el del handshake de
 * Meta (Fase 19, Etapa B): Meta lo manda en cada verificación de webhook.
 */
const QUERY_SENSIBLE = new Set(["hub.verify_token"]);

/**
 * Censura secretos que viajan en la URL. Conserva la forma de la ruta y el
 * resto de la query intactos: se pierde el secreto, no la trazabilidad.
 */
export function sanitizarUrl(url: string): string {
  const corte = url.indexOf("?");
  const pathCrudo = corte === -1 ? url : url.slice(0, corte);
  const queryCruda = corte === -1 ? null : url.slice(corte + 1);

  const path = pathCrudo.replace(RUTAS_CON_TOKEN, (_match, ruta: string) => `/${ruta}/[REDACTED]`);
  if (queryCruda === null) return path;

  const params = new URLSearchParams(queryCruda);
  let censurado = false;
  for (const clave of [...params.keys()]) {
    if (QUERY_SENSIBLE.has(clave)) {
      params.set(clave, "[REDACTED]");
      censurado = true;
    }
  }
  // Solo se re-serializa la query si hubo algo que censurar: así una URL
  // sin secretos se loguea byte por byte como llegó.
  return `${path}?${censurado ? params.toString() : queryCruda}`;
}

interface RequestLoggeable {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

/**
 * Instancia única de logging estructurado (ver
 * docs/fase-8-observabilidad-seguridad/tracing.md y ADR-009). Cada módulo
 * que ya tenga `tenant_id`/`conversation_id` en scope hace
 * `logger.child({ tenant_id, conversation_id })` en vez de recibir un
 * logger por parámetro — evita tocar firmas de funciones existentes solo
 * para instrumentar. Emite JSON a stdout: es lo que un agente de reenvío
 * (Fly.io → Grafana Cloud/Loki) consume, sin transporte propio en el código.
 */
/**
 * PII fuera de logs (ver docs/fase-8-observabilidad-seguridad/revision-seguridad.md):
 * los puntos de log de esta app ya evitan por diseño loguear teléfono
 * completo o texto literal del mensaje (solo tenant_id/conversation_id
 * para correlación) — este redact es defensa en profundidad por si
 * algún campo así se agrega por error a futuro. El historial completo
 * de la conversación vive en Postgres con RLS, no en logs de terceros.
 *
 * Exportada para que el test ejercite esta lista y no una copia suya: una
 * copia se desincroniza sin que nadie se entere, que es justo como se coló
 * `destinatario` en claro.
 */
export const REDACT_PATHS = [
  "req.body",
  "customer_phone",
  "*.customer_phone",
  "body",
  "*.body",
  "to",
  "*.to",
  "from",
  "*.from",
  // `delivery.rechazado` (webhookHandler.ts) reporta a quién no le llegó el
  // mensaje. La clave está en español, así que no la cubrían `to`/`from`.
  "destinatario",
  "*.destinatario",
];

export const logger = pino({
  level: env.logLevel,
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
  },
  // El access log de Fastify (que usa esta misma instancia vía
  // `loggerInstance`, ver src/gateway/server.ts) serializa la URL completa.
  // `redact` no sirve acá: censura campos enteros, y perder la URL entera
  // dejaría los logs HTTP sin valor. Se reemplaza el serializer de `req`
  // conservando los mismos campos que emite Fastify por defecto.
  serializers: {
    req(request: RequestLoggeable) {
      return {
        method: request.method,
        url: sanitizarUrl(request.url ?? ""),
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket?.remotePort,
      };
    },
  },
});
