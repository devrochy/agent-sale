/**
 * Envuelve `fetch` con un límite de tiempo duro. Ver incidente 2026-09-13
 * (docs del plan de remediación en el historial de conversación): ningún
 * fetch a una API externa tenía timeout, y el consumer de mensajes
 * (src/orchestrator/consumer.ts) procesa un mensaje a la vez — un solo
 * fetch que se quedara "colgado" (TCP conectado, sin respuesta) bloqueaba
 * el pipeline entero indefinidamente, no solo la conversación afectada.
 *
 * `AbortSignal.timeout(ms)` es nativo desde Node 18 (el repo pide Node
 * ≥22, ver package.json) — no hace falta armar un `AbortController` ni un
 * `setTimeout` a mano. Si el signal aborta antes de que `fetch` resuelva,
 * Node lanza un `DOMException`/`Error` con `name === "TimeoutError"`; acá
 * se normaliza a un mensaje claro con la URL y el límite configurado, para
 * que el log del error diga por sí solo qué pasó sin tener que inspeccionar
 * el tipo de excepción.
 */
export interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs: number;
}

export async function fetchWithTimeout(
  url: string,
  { timeoutMs, ...init }: FetchWithTimeoutOptions,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`Timeout de ${timeoutMs}ms excedido: ${url}`);
    }
    throw error;
  }
}
