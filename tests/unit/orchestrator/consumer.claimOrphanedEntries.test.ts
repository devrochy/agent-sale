import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// claimOrphanedEntries (Fase 5 del plan de remediación del incidente
// 2026-09-13, exportada igual que fireConversation en debounceScheduler.ts
// — se prueba directo en vez de forzar el loop infinito de
// startConsumer()): al arrancar, XAUTOCLAIM reclama entradas "pending" de
// un consumer muerto (PID distinto tras un crash/kill -9) y las procesa
// igual que si hubieran llegado por xreadgroup normal.
const xgroup = vi.fn();
const xreadgroup = vi.fn();
const xautoclaim = vi.fn();
const xack = vi.fn();
const xpending = vi.fn();
const xadd = vi.fn();

vi.mock("../../../src/shared/redis/client.js", () => ({
  redis: { xgroup, xreadgroup, xautoclaim, xack, xpending, xadd },
}));

const { claimOrphanedEntries } = await import("../../../src/orchestrator/consumer.js");

// Entrada sin campos: parseInboundFields (gateway/queue.ts) defaultea
// messageSid/customerExternalId a "" — processEntry las descarta con un
// simple XACK, el camino más corto y el único que hace falta mockear para
// probar que claimOrphanedEntries() efectivamente reprocesa lo reclamado.
function entryFields(): string[] {
  return [];
}

describe("claimOrphanedEntries", () => {
  beforeEach(() => {
    xack.mockReset().mockResolvedValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pagina con XAUTOCLAIM hasta el cursor terminal y procesa cada entrada reclamada", async () => {
    // "0-0" (el ID completo, no el "0" corto de arranque) es el cursor real
    // que devuelve Redis cuando no queda nada más por paginar — verificado
    // contra un Redis real, no asumido (ver claimOrphanedEntries en
    // consumer.ts). Un mock que solo probara con "0" no habría detectado
    // el bug real: Redis nunca devuelve ese valor como cursor terminal.
    xautoclaim
      .mockReset()
      .mockResolvedValueOnce(["cursor-1", [["1-0", entryFields()]], []])
      .mockResolvedValueOnce(["0-0", [["2-0", entryFields()]], []]);

    await claimOrphanedEntries();

    expect(xautoclaim).toHaveBeenCalledTimes(2);
    expect(xautoclaim).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      "orchestrator-group",
      expect.stringContaining("orchestrator-"),
      60_000,
      "0",
      "COUNT",
      20,
    );
    expect(xautoclaim).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      "orchestrator-group",
      expect.stringContaining("orchestrator-"),
      60_000,
      "cursor-1",
      "COUNT",
      20,
    );
    // Las 2 entradas reclamadas (payload inválido a propósito) se
    // procesaron — cada una hizo su propio XACK vía processEntry.
    expect(xack).toHaveBeenCalledTimes(2);
  });

  it("sin entradas huérfanas, hace una sola llamada y no procesa nada", async () => {
    xautoclaim.mockReset().mockResolvedValueOnce(["0-0", [], []]);

    await claimOrphanedEntries();

    expect(xautoclaim).toHaveBeenCalledTimes(1);
    expect(xack).not.toHaveBeenCalled();
  });
});
