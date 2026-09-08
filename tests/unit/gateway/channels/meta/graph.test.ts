import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { graphRequest } from "../../../../../src/gateway/channels/meta/graph.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("graphRequest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reintenta una vez si fetch() lanza (fallo de red) y devuelve el resultado del segundo intento", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.ok" }] }));

    const promise = graphRequest<{ messages: Array<{ id: string }> }>(
      "https://graph.facebook.com/v25.0/123/messages",
      { method: "POST" },
      "contexto de prueba",
    );
    // El reintento espera RETRY_DELAY_MS — avanzar los timers simulados
    // para no depender de tiempo real en el test.
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toEqual({ messages: [{ id: "wamid.ok" }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("propaga el error si el reintento también falla", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));

    const promise = graphRequest("https://graph.facebook.com/v25.0/123/messages", { method: "POST" }, "contexto de prueba");
    const expectation = expect(promise).rejects.toThrow("fetch failed");
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("NO reintenta si Meta responde con un error de negocio (plantilla no aprobada, etc.)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: { message: "Invalid parameter", code: 100 } }, false, 400),
    );

    await expect(
      graphRequest("https://graph.facebook.com/v25.0/123/messages", { method: "POST" }, "contexto de prueba"),
    ).rejects.toThrow(/contexto de prueba/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("NO reintenta si la respuesta llega con !response.ok (sin cuerpo de error)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, false, 500));

    await expect(
      graphRequest("https://graph.facebook.com/v25.0/123/messages", { method: "POST" }, "contexto de prueba"),
    ).rejects.toThrow(/HTTP 500/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("primer intento exitoso: no reintenta", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.directo" }] }));

    const result = await graphRequest<{ messages: Array<{ id: string }> }>(
      "https://graph.facebook.com/v25.0/123/messages",
      { method: "POST" },
      "contexto de prueba",
    );

    expect(result).toEqual({ messages: [{ id: "wamid.directo" }] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
