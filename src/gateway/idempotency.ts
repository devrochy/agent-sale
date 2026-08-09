import type { Provider } from "../shared/db/connectionsDirectory.js";
import { redis } from "../shared/redis/client.js";

const TTL_MS = 48 * 60 * 60 * 1000; // 48h — ver docs/fase-3-whatsapp-gateway/idempotencia.md

/**
 * La clave lleva el proveedor desde la Fase 19: los identificadores de
 * mensaje de Twilio y de Meta vienen de espacios distintos y no hay garantía
 * de que no colisionen.
 *
 * El prefijo cambió de `wa:processed:` a `inbound:{provider}:` — decisión
 * consciente, no descuido: durante el release en el que se despliega esto, un
 * reintento de un mensaje ya procesado con el prefijo viejo se vería como
 * nuevo y se procesaría dos veces. Con el volumen actual la ventana es
 * despreciable frente a la alternativa (leer dos prefijos y escribir uno solo
 * durante un release, que hay que acordarse de limpiar después).
 */
function processedKey(provider: Provider, externalMessageId: string): string {
  return `inbound:${provider}:${externalMessageId}`;
}

/**
 * true si es la primera vez que se ve este mensaje (se reclama vía SET NX);
 * false si ya se había procesado (reintento del proveedor). Si Redis falla,
 * se propaga el error — el caller falla cerrado: no encola en vez de
 * arriesgar un pedido duplicado (ver idempotencia.md, "qué pasa si Redis no
 * está disponible").
 */
export async function claimMessageOnce(
  provider: Provider,
  externalMessageId: string,
): Promise<boolean> {
  const result = await redis.set(
    processedKey(provider, externalMessageId),
    "1",
    "PX",
    TTL_MS,
    "NX",
  );
  return result === "OK";
}
