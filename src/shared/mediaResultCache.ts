import { redis } from "./redis/client.js";

/**
 * Cache de idempotencia para el resultado de una llamada de IA pagada
 * sobre un media entrante (OCR del comprobante, transcripción de audio,
 * descripción de foto de producto) — ver hallazgo de code review: sin
 * esto, un reintento de la cola (`orchestrator/consumer.ts`, hasta
 * `MAX_DELIVERIES` veces) que falla DESPUÉS de que la llamada ya tuvo
 * éxito (ej. falla el envío del mensaje siguiente) vuelve a llamar la API
 * pagada para el mismo mensaje, multiplicando el costo.
 *
 * Clave por `messageSid` (el id del mensaje en el proveedor — ya es la
 * base de la idempotencia del resto del pipeline, ver
 * `gateway/idempotency.ts`), no por `inboundMediaId`: lo que hay que
 * evitar repetir es la llamada cara para ESTE mensaje puntual, sin
 * importar cuántas filas de `inbound_media` termine habiendo.
 *
 * TTL corto a propósito: no es un cache de resultados a largo plazo, es
 * una ventana que cubre los reintentos de un mismo mensaje en la cola.
 */
const TTL_MS = 60 * 60 * 1000; // 1h — de sobra para los reintentos de consumer.ts.

function claveResultado(messageSid: string): string {
  return `media:resultado:${messageSid}`;
}

export interface CachedMediaResult<T> {
  value: T;
}

export async function getCachedMediaResult<T>(messageSid: string): Promise<CachedMediaResult<T> | null> {
  const raw = await redis.get(claveResultado(messageSid));
  return raw === null ? null : (JSON.parse(raw) as CachedMediaResult<T>);
}

/** `value` puede ser `null` en sí mismo (ej. "Whisper no transcribió nada") — se envuelve en `{ value }` para distinguir eso de "no hay nada cacheado todavía". */
export async function setCachedMediaResult<T>(messageSid: string, value: T): Promise<void> {
  await redis.set(claveResultado(messageSid), JSON.stringify({ value }), "PX", TTL_MS);
}
