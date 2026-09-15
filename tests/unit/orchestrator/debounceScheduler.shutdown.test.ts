import { afterEach, describe, expect, it, vi } from "vitest";

// Graceful shutdown (Fase 4 del plan de remediación del incidente
// 2026-09-13, ver src/index.ts): startDebounceScheduler() debe dejar de
// invocar pollDebounceOnce() después de requestDebounceSchedulerShutdown(),
// sin cortar el poll en curso.
const zrangebyscore = vi.fn();

vi.mock("../../../src/shared/redis/client.js", () => ({
  redis: {
    zrangebyscore,
    zrem: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    set: vi.fn(),
    zadd: vi.fn(),
    zscore: vi.fn(),
  },
}));
// bot_paused: true hace que recoverOrphanedConversations() (llamada una
// sola vez al arrancar) devuelva de inmediato sin tocar Postgres — no es
// lo que se está probando acá.
vi.mock("../../../src/shared/db/settingsDirectory.js", () => ({
  getSettings: vi.fn().mockResolvedValue({ bot_paused: true }),
  getBehaviorConfig: vi.fn(),
}));

const { startDebounceScheduler, requestDebounceSchedulerShutdown } = await import(
  "../../../src/orchestrator/debounceScheduler.js"
);

describe("startDebounceScheduler — graceful shutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("deja de invocar pollDebounceOnce tras requestDebounceSchedulerShutdown(), sin cortar el poll en curso", async () => {
    vi.useFakeTimers();
    let pollCount = 0;
    zrangebyscore.mockImplementation(async () => {
      pollCount++;
      if (pollCount === 2) {
        requestDebounceSchedulerShutdown();
      }
      return [];
    });

    const promise = startDebounceScheduler();
    // Cada iteración del loop espera POLL_INTERVAL_MS (1.5s) después del
    // poll, incluida la que dispara el shutdown — hay que avanzar el timer
    // dos veces para dejar que el loop vuelva a chequear la condición.
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    expect(pollCount).toBe(2);
  });
});
