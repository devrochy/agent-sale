import { createHash } from "node:crypto";

/**
 * Wompi advierte explícitamente no asumir `signature.properties` como un
 * array fijo entre eventos — por eso las rutas se resuelven en tiempo de
 * verificación contra el `data` real del evento recibido, nunca
 * hardcodeadas acá.
 */
function resolvePath(data: unknown, path: string): string {
  const value = path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, data);
  return value === null || value === undefined ? "" : String(value);
}

/**
 * Verifica el checksum de un evento de Wompi (ver
 * docs/fase-12-capacidades-proactivas-agente/adrs/ADR-024-cobros-wompi-confirmacion-automatica.md):
 * SHA256 de la concatenación de los valores en `signature.properties`
 * (rutas dentro de `data`, en el orden dado) + el timestamp del evento +
 * el secreto de eventos del tenant. Mismo propósito que
 * `verifyTwilioSignature` (src/gateway/twilioSignature.ts) — autenticidad
 * del webhook — con el algoritmo propio de Wompi en vez de HMAC.
 */
export function verifyWompiChecksum(
  data: unknown,
  properties: string[],
  timestamp: number,
  receivedChecksum: string,
  eventsSecret: string,
): boolean {
  const concatenated =
    properties.map((path) => resolvePath(data, path)).join("") + String(timestamp) + eventsSecret;
  const expected = createHash("sha256").update(concatenated).digest("hex");
  return expected === receivedChecksum;
}
