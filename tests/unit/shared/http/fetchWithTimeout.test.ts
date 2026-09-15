import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "../../../../src/shared/http/fetchWithTimeout.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWithTimeout", () => {
  it("caso feliz: devuelve la respuesta cuando fetch resuelve antes del timeout", async () => {
    const response = { ok: true, status: 200 } as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const result = await fetchWithTimeout("https://example.com", { timeoutMs: 5000 });

    expect(result).toBe(response);
  });

  it("pasa un AbortSignal a fetch (ligado al timeoutMs pedido)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithTimeout("https://example.com", { timeoutMs: 1234, method: "POST" });

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect((init as RequestInit).method).toBe("POST");
  });

  it("timeout: normaliza el abort a un Error legible con la URL y el límite excedido", async () => {
    // Simula lo que hace el fetch real de Node cuando el signal pasado
    // aborta: rechaza con un DOMException name=TimeoutError. Acá se arma a
    // mano porque el mock reemplaza fetch entero, así que nadie más
    // escucha el AbortSignal real.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
          });
        });
      }),
    );

    await expect(fetchWithTimeout("https://api.deepseek.com/chat/completions", { timeoutMs: 5 })).rejects.toThrow(
      "Timeout de 5ms excedido: https://api.deepseek.com/chat/completions",
    );
  });

  it("error de red real (no timeout): se propaga tal cual, sin reescribir el mensaje", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    await expect(fetchWithTimeout("https://example.com", { timeoutMs: 5000 })).rejects.toThrow("fetch failed");
  });
});
