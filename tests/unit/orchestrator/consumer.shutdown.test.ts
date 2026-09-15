import { describe, expect, it, vi } from "vitest";

// Graceful shutdown (Fase 4 del plan de remediación del incidente
// 2026-09-13, ver src/index.ts): startConsumer() debe dejar de invocar
// pollOnce() después de requestConsumerShutdown(), pero sin cortar el
// poll que ya estaba en curso a mitad de camino.
const xgroup = vi.fn();
const xreadgroup = vi.fn();

vi.mock("../../../src/shared/redis/client.js", () => ({
  redis: {
    xgroup,
    xreadgroup,
    xack: vi.fn(),
    xadd: vi.fn(),
    xpending: vi.fn(),
  },
}));

const { startConsumer, requestConsumerShutdown } = await import("../../../src/orchestrator/consumer.js");

describe("startConsumer — graceful shutdown", () => {
  it("deja de invocar pollOnce tras requestConsumerShutdown(), sin cortar el poll en curso", async () => {
    xgroup.mockResolvedValue("OK");
    let xreadgroupCalls = 0;
    xreadgroup.mockImplementation(async () => {
      xreadgroupCalls++;
      // pollOnce hace 2 llamadas a xreadgroup por iteración (pendientes
      // "0", luego nuevas ">"). Se pide el shutdown a mitad de la
      // *primera* iteración — el poll en curso (la segunda llamada de esa
      // misma iteración) debe completarse igual, sin cortarse.
      if (xreadgroupCalls === 2) {
        requestConsumerShutdown();
      }
      return null;
    });

    await startConsumer();

    expect(xgroup).toHaveBeenCalledTimes(1); // ensureConsumerGroup, siempre corre
    // Se completó la iteración en curso (2 llamadas) y no arrancó una
    // tercera — el loop paró apenas pudo, no a la fuerza.
    expect(xreadgroupCalls).toBe(2);
  });
});
