import { describe, expect, it } from "vitest";

// El heurístico vive inline en pool.ts/client.ts (ver plan de la Fase 8:
// "tres líneas similares es mejor que una abstracción prematura"), se
// aísla acá como función pura para no acoplar el test a una conexión real.
function isLocalHost(url: string): boolean {
  return ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
}

describe("isLocalHost (heurístico de TLS para Postgres/Redis)", () => {
  it("reconoce localhost y 127.0.0.1 como locales", () => {
    expect(isLocalHost("postgres://user:pass@localhost:5432/db")).toBe(true);
    expect(isLocalHost("redis://127.0.0.1:6379")).toBe(true);
  });

  it("trata cualquier otro host como remoto (requiere TLS)", () => {
    expect(isLocalHost("postgres://user:pass@db.supabase.co:5432/db")).toBe(false);
    expect(isLocalHost("redis://my-redis.upstash.io:6379")).toBe(false);
  });
});
