import { beforeEach, describe, expect, it, vi } from "vitest";

// Single-flight del caché de conexiones (Fase 6 del plan de remediación
// del incidente 2026-09-13, ver connectionsDirectory.ts): dos llamadas
// concurrentes durante un cache-miss deben compartir una sola query a
// Postgres, no disparar una cada una — esa asimetría de latencia
// (una pega el round-trip real, la otra un cache-hit) es uno de los
// mecanismos con más evidencia para explicar el desorden del incidente.
const query = vi.fn();

vi.mock("../../../../src/shared/db/pool.js", () => ({ pool: { query } }));
vi.mock("../../../../src/shared/crypto/secretBox.js", () => ({
  decryptSecret: vi.fn().mockReturnValue("{}"),
  encryptSecret: vi.fn(),
}));

const { listConnections, invalidateConnectionsCache } = await import(
  "../../../../src/shared/db/connectionsDirectory.js"
);

function connectionRow() {
  return {
    id: "conn-1",
    channel: "whatsapp",
    provider: "twilio",
    label: "WhatsApp",
    active: true,
    is_primary: true,
    external_id: "whatsapp:+573000000000",
    display_address: "whatsapp:+573000000000",
    credentials_encrypted: "cifrado-falso",
    updated_at: new Date(),
  };
}

describe("connectionsDirectory — single-flight de loadAll()", () => {
  beforeEach(() => {
    invalidateConnectionsCache();
    query.mockReset();
  });

  it("dos llamadas concurrentes durante un cache-miss comparten una sola query", async () => {
    let resolveQuery!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveQuery = resolve;
    });
    query.mockReturnValueOnce(pending);

    // Arrancan las dos antes de que la query resuelva — es exactamente el
    // escenario de dos webhooks casi simultáneos con el caché recién
    // expirado.
    const p1 = listConnections();
    const p2 = listConnections();

    resolveQuery({ rows: [connectionRow()] });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
    expect(r1).toHaveLength(1);
  });

  it("resuelto el cache-miss, las llamadas siguientes usan el caché sin volver a golpear Postgres", async () => {
    query.mockResolvedValueOnce({ rows: [connectionRow()] });

    await listConnections();
    await listConnections();
    await listConnections();

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("si la query falla, no deja el in-flight colgado — la siguiente llamada reintenta de verdad", async () => {
    query.mockRejectedValueOnce(new Error("conexión perdida"));
    await expect(listConnections()).rejects.toThrow("conexión perdida");

    query.mockResolvedValueOnce({ rows: [connectionRow()] });
    const result = await listConnections();

    expect(query).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
  });
});
