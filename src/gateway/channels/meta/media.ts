import type { ConnectionCredentials } from "../../../shared/db/connectionsDirectory.js";
import { GRAPH_API_BASE, appSecretProof, graphRequest, requireToken } from "./graph.js";

/**
 * Descarga de medios entrantes (imagen/audio) de la Graph API de Meta —
 * usado por el pipeline de ingesta (ver docs del plan "medios entrantes":
 * comprobante de transferencia con OCR, búsqueda por foto, audio de
 * entrada). Dos pasos, como exige Meta: primero resolver el id del media a
 * una URL temporal (`GET /{media-id}`), después descargar los bytes de esa
 * URL — ninguno de los dos es JSON de la Graph API propiamente dicho en el
 * segundo paso, así que no pasa por `graphRequest`.
 *
 * La URL temporal expira rápido (unos minutos) y requiere el mismo Bearer
 * token que el resto de la Graph API — no es pública aunque lo parezca.
 */

function appSecretProofParams(credentials: ConnectionCredentials, token: string): string {
  return credentials.appSecret ? `?appsecret_proof=${appSecretProof(token, credentials.appSecret)}` : "";
}

export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
}

interface MetaMediaMetadata {
  url?: string;
  mime_type?: string;
  file_size?: string;
}

/** Límite defensivo: un comprobante o una nota de voz no deberían pesar más de esto — evita que un media_id inesperado tire abajo el proceso con un archivo gigante. */
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export async function downloadMedia(
  credentials: ConnectionCredentials,
  mediaId: string,
): Promise<DownloadedMedia> {
  const token = requireToken(credentials);
  const proofParams = appSecretProofParams(credentials, token);

  const metadata = await graphRequest<MetaMediaMetadata>(
    `${GRAPH_API_BASE}/${mediaId}${proofParams}`,
    { headers: { Authorization: `Bearer ${token}` } },
    "Meta rechazó la consulta del media",
  );
  if (!metadata.url) {
    throw new Error("Meta no devolvió la URL temporal del media");
  }

  const response = await fetch(metadata.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`No se pudo descargar el media de Meta: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_MEDIA_BYTES) {
    throw new Error(`El media de Meta pesa más de lo esperado (${arrayBuffer.byteLength} bytes)`);
  }
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: metadata.mime_type ?? "application/octet-stream",
  };
}
