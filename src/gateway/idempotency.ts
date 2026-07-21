import { redis } from "../shared/redis/client.js";

const PROCESSED_KEY_PREFIX = "wa:processed:";
const TTL_MS = 48 * 60 * 60 * 1000; // 48h — ver docs/fase-3-whatsapp-gateway/idempotencia.md

/**
 * true si es la primera vez que se ve este MessageSid (se reclama vía
 * SET NX); false si ya se había procesado (reintento de Twilio). Si Redis
 * falla, se propaga el error — el caller falla cerrado: no encola en vez
 * de arriesgar un pedido duplicado (ver idempotencia.md, "qué pasa si
 * Redis no está disponible").
 */
export async function claimMessageOnce(messageSid: string): Promise<boolean> {
  const result = await redis.set(`${PROCESSED_KEY_PREFIX}${messageSid}`, "1", "PX", TTL_MS, "NX");
  return result === "OK";
}
