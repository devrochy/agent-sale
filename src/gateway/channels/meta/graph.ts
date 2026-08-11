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
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

/**
 * La Graph API señala fallas con un objeto `error` en el body. En la mayoría
 * de los casos viene con un status HTTP de error, pero no siempre — así que se
 * chequean las dos cosas y no solo el status.
 */
export async function graphRequest<T>(
  url: string,
  init: RequestInit,
  contexto: string,
): Promise<T & GraphError> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & GraphError;

  if (!response.ok || body.error) {
    const detalle = body.error?.message ?? `HTTP ${response.status}`;
    const codigo = body.error?.code !== undefined ? ` (código ${body.error.code})` : "";
    throw new Error(`${contexto}: ${detalle}${codigo}`);
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
