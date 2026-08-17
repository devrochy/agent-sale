import { describe, expect, it } from "vitest";

import { requiresTls } from "../../../../src/shared/tlsPolicy.js";

describe("requiresTls (política de TLS para Postgres/Redis)", () => {
  it("no exige TLS en localhost ni 127.0.0.1", () => {
    expect(requiresTls("postgres://user:pass@localhost:5432/db")).toBe(false);
    expect(requiresTls("redis://127.0.0.1:6379")).toBe(false);
  });

  it("exige TLS en un servicio gestionado alcanzable por Internet", () => {
    expect(requiresTls("postgres://user:pass@db.supabase.co:5432/db")).toBe(true);
    expect(requiresTls("redis://my-redis.upstash.io:6379")).toBe(true);
  });

  it("no exige TLS a un nombre de servicio de red Docker", () => {
    // Coolify nombra los contenedores con el uuid del recurso: sin punto, no
    // resuelve fuera del host, y no trae TLS configurado.
    expect(requiresTls("postgres://app:pass@pxm3ju8bet4rdmkxeifwpzlu:5432/agent_sale")).toBe(false);
    expect(requiresTls("redis://default:pass@nnpoyxwzms5q7hmz9abseaag:6379")).toBe(false);
  });

  it("respeta sslmode=disable explícito", () => {
    expect(requiresTls("postgres://user:pass@db.example.com:5432/db?sslmode=disable")).toBe(false);
  });

  it("sigue exigiendo TLS si sslmode pide lo contrario", () => {
    expect(requiresTls("postgres://user:pass@db.example.com:5432/db?sslmode=require")).toBe(true);
  });
});
