import { createHmac } from "node:crypto";
import type { ConnectionCredentials } from "../../../shared/db/connectionsDirectory.js";

/**
 * Lo común de las dos APIs de Meta que usa el sistema: WhatsApp Cloud API
 * (Etapa B) e Instagram Messaging (Etapa C2). Comparten host, versión,
 * autenticación y forma de reportar errores; lo que cambia es el endpoint y el
 * cuerpo, y eso vive en `outbound.ts`.
 *
 * Versión de la Graph API: v25.0, publicada en febrero de 2026 y vigente hasta
 * julio de 2028. Se eligió sobre la última (v26.0, de hace unas semanas) por
 * madurez, y sobre las anteriores por vida útil restante. Cuando se acerque su
 * expiración hay que subirla acá y revisar el changelog de Meta.
 */
export const GRAPH_API_VERSION = "v25.0";
export const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

interface GraphError {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
    error_data?: { details?: string };
  };
}

// Backoff del único reintento ante un fallo de red (ver docblock de
// graphRequest más abajo) — corto a propósito: es para un blip transitorio
// de conexión, no para esperar a que Meta se recupere de una caída real.
const RETRY_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * La Graph API señala fallas con un objeto `error` en el body. En la mayoría
 * de los casos viene con un status HTTP de error, pero no siempre — así que se
 * chequean las dos cosas y no solo el status.
 *
 * `error.message` suele ser genérico ("Invalid parameter", código 100, sin
 * más contexto — visto de primera mano al crear `confirmar_domicilio`, ver
 * docs/fase-3-whatsapp-gateway/plantillas-mensajes.md). Meta casi siempre
 * manda el motivo real en `error_user_msg`/`error_user_title` (pensados para
 * mostrar al usuario final de la Graph API) o en `error_data.details` — se
 * anteponen cuando existen para no dejar al admin solo con el código.
 *
 * Un solo reintento cuando el propio `fetch()` lanza (no cuando Meta
 * responde con un error de negocio: eso sigue sin reintentarse, sea
 * plantilla no aprobada o un parámetro inválido — reintentar eso no cambia
 * nada). Confirmado en logs reales (2026-09-08, entorno test): un
 * `preguntar_metodo_pago` falló con "fetch failed" — la excepción genérica
 * que tira `fetch` de Node ante un problema de conexión/DNS/TLS, sin
 * response — justo después de un redeploy, un blip de red transitorio. Sin
 * reintento, ese único fallo tumba toda la cadena de plantillas del flujo de
 * venta y el LLM cae al fallback de preguntar por texto (el mismo texto
 * libre que este flujo entero busca evitar). Reintentar acá es seguro
 * porque `fetch` lanzando significa que la request nunca completó el
 * round-trip — no hay riesgo real de que Meta ya haya recibido y procesado
 * la primera, a diferencia de un timeout después de enviar.
 */
export async function graphRequest<T>(
  url: string,
  init: RequestInit,
  contexto: string,
): Promise<T & GraphError> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    await sleep(RETRY_DELAY_MS);
    response = await fetch(url, init);
  }
  const body = (await response.json().catch(() => ({}))) as T & GraphError;

  if (!response.ok || body.error) {
    const err = body.error;
    const detalle = err?.error_user_msg ?? err?.error_data?.details ?? err?.message ?? `HTTP ${response.status}`;
    const titulo = err?.error_user_title ? `${err.error_user_title}: ` : "";
    const codigo = err?.code !== undefined ? ` (código ${err.code}${err.error_subcode ? `/${err.error_subcode}` : ""})` : "";
    throw new Error(`${contexto}: ${titulo}${detalle}${codigo}`);
  }
  return body;
}

/**
 * `appsecret_proof`: HMAC-SHA256 del access token con el App Secret como
 * clave. Es el único modo de comprobar el secret sin esperar a que llegue un
 * webhook — Meta lo valida cuando viene y rechaza la llamada si no cuadra.
 */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

export function requireToken(credentials: ConnectionCredentials): string {
  const { accessToken } = credentials;
  if (!accessToken) {
    throw new Error("La conexión de Meta no tiene accessToken configurado");
  }
  return accessToken;
}
