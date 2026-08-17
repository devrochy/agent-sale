/**
 * Decide si una conexión a un servicio de infraestructura (Postgres, Redis)
 * tiene que ir cifrada.
 *
 * La regla base es la de la Fase 8 (ver
 * docs/fase-8-observabilidad-seguridad/revision-seguridad.md, "TLS en todas
 * las conexiones"): TLS para todo lo que no sea local, sin depender de que
 * la cadena de conexión traiga `sslmode=require`/`rediss://` ni de que
 * alguien acuerde de setear NODE_ENV.
 *
 * Vivía duplicada e inline en pool.ts y client.ts —una línea cada una, y ahí
 * duplicar salía más barato que abstraer—. Al aparecer el despliegue en
 * Coolify pasó a ser un heurístico de varios casos, y dos copias de un
 * heurístico de seguridad es justo lo que no conviene tener.
 */
export function requiresTls(connectionUrl: string): boolean {
  const url = new URL(connectionUrl);

  // El docker-compose de desarrollo.
  if (["localhost", "127.0.0.1"].includes(url.hostname)) return false;

  // Un hostname sin punto es un nombre de servicio dentro de una red de
  // Docker (Coolify nombra los contenedores con el uuid del recurso:
  // `pxm3ju8bet4rdmkxeifwpzlu`). No resuelve en Internet, el tráfico no sale
  // del demonio de Docker, y esos Postgres/Redis no traen TLS configurado:
  // exigirlo no protege de nada y deja la aplicación sin arrancar.
  if (!url.hostname.includes(".")) return false;

  // Escape explícito, para un servicio gestionado al que ya se llega por un
  // túnel cifrado.
  if (url.searchParams.get("sslmode") === "disable") return false;

  return true;
}
