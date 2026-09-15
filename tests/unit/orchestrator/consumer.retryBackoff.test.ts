import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Backoff entre reintentos de un mensaje que falló (Fase 6 del plan de
// remediación del incidente 2026-09-13, ver el catch de processEntry en
// consumer.ts, exportada igual que fireConversation/claimOrphanedEntries
// en sus respectivas fases): antes, un mensaje que fallaba se reintentaba
// en caliente en la siguiente iteración del loop — sin ninguna espera.
const xpending = vi.fn();
const xack = vi.fn();
const xadd = vi.fn();

vi.mock("../../../src/shared/redis/client.js", () => ({
  redis: { xpending, xack, xadd, xgroup: vi.fn(), xreadgroup: vi.fn(), xautoclaim: vi.fn() },
}));
// Primera línea del try de processEntry — rechazarla es el camino más
// corto para llegar al catch sin tener que simular todo el resto del
// pipeline de negocio (settings, resolución de conversación, etc.).
vi.mock("../../../src/orchestrator/satisfactionSurvey.js", () => ({
  tryCaptureSurveyReply: vi.fn().mockRejectedValue(new Error("fallo simulado de negocio")),
}));

const { processEntry } = await import("../../../src/orchestrator/consumer.js");

const FIELDS = ["message_sid", "sid-1", "customer_phone", "+573000000000"];

describe("processEntry — backoff entre reintentos", () => {
  beforeEach(() => {
    xpending.mockReset();
    xack.mockReset().mockResolvedValue(1);
    xadd.mockReset().mockResolvedValue("1-0");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("con delivery_count=1 (no llega a dead-letter), espera un backoff antes de terminar", async () => {
    vi.useFakeTimers();
    xpending.mockResolvedValue([["1-0", "otro-consumer", 5000, 1]]);

    const promise = processEntry("1-0", FIELDS);
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });

    // Backoff esperado: delivery_count(1) * 2000ms = 2000ms.
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1500);
    await promise;
    expect(resolved).toBe(true);
    // No se movió a dead-letter con solo 1 intento fallido.
    expect(xadd).not.toHaveBeenCalled();
  });

  it("con delivery_count >= MAX_DELIVERIES, va a dead-letter sin esperar backoff", async () => {
    xpending.mockResolvedValue([["2-0", "otro-consumer", 5000, 3]]);

    await processEntry("2-0", FIELDS);

    expect(xadd).toHaveBeenCalledTimes(1); // moveToDeadLetter
    expect(xack).toHaveBeenCalledTimes(1);
  });
});
