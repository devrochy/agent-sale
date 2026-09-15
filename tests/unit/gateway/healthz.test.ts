import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// /healthz real (ver incidente 2026-09-13): antes devolvía {status:"ok"}
// sin chequear nada. Se mockean pool/redis/consumer enteros — el resto de
// server.ts (admin, webhooks, etc.) se importa tal cual, pero ninguna otra
// ruta se toca en este test, así que sus dependencias reales (DB real, más
// allá de la construcción perezosa del Pool) nunca llegan a ejecutarse.
const poolQuery = vi.fn();
const redisPing = vi.fn();
const getConsumerLastPollAt = vi.fn();

vi.mock("../../../src/shared/db/pool.js", () => ({ pool: { query: poolQuery } }));
vi.mock("../../../src/shared/redis/client.js", () => ({ redis: { ping: redisPing } }));
vi.mock("../../../src/orchestrator/consumer.js", () => ({ getConsumerLastPollAt }));

const { buildServer } = await import("../../../src/gateway/server.js");

describe("GET /healthz", () => {
  beforeEach(() => {
    poolQuery.mockReset().mockResolvedValue({ rows: [{ "?column?": 1 }] });
    redisPing.mockReset().mockResolvedValue("PONG");
    getConsumerLastPollAt.mockReset().mockReturnValue(Date.now());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("200 + status ok cuando Postgres, Redis y el consumer están sanos", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", postgres: "ok", redis: "ok", consumer: "ok" });
  });

  it("503 si Postgres falla", async () => {
    poolQuery.mockRejectedValue(new Error("connection refused"));

    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "degraded", postgres: "error", redis: "ok" });
  });

  it("503 si Redis falla", async () => {
    redisPing.mockRejectedValue(new Error("ECONNREFUSED"));

    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "degraded", postgres: "ok", redis: "error" });
  });

  it("503 si el consumer lleva más del umbral sin completar un ciclo de poll (trabado)", async () => {
    getConsumerLastPollAt.mockReturnValue(Date.now() - 120_000);

    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "degraded", consumer: "stalled" });
  });

  it("200 si el último poll fue reciente, aunque no sea instantáneo (margen normal del loop)", async () => {
    getConsumerLastPollAt.mockReturnValue(Date.now() - 10_000);

    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
  });
});
