import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadMedia } from "../../../../../src/gateway/channels/meta/media.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function bytesResponse(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  } as Response;
}

describe("downloadMedia", () => {
  it("resuelve la URL temporal y descarga los bytes en dos pasos", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ url: "https://lookaside.fbsbx.com/temp/x", mime_type: "image/png" }))
      .mockResolvedValueOnce(bytesResponse("contenido-de-la-imagen"));

    const resultado = await downloadMedia({ accessToken: "token-test" }, "media-id-123");

    expect(resultado.mimeType).toBe("image/png");
    expect(resultado.buffer.toString("utf8")).toBe("contenido-de-la-imagen");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toContain("/media-id-123");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://lookaside.fbsbx.com/temp/x");
  });

  it("agrega appsecret_proof cuando la conexión tiene appSecret", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ url: "https://lookaside.fbsbx.com/temp/y", mime_type: "audio/ogg" }))
      .mockResolvedValueOnce(bytesResponse("audio"));

    await downloadMedia({ accessToken: "token-test", appSecret: "secreto" }, "media-id-456");

    expect(fetchMock.mock.calls[0]![0]).toContain("appsecret_proof=");
  });

  it("lanza si Meta rechaza la consulta del media (id inexistente, token vencido, etc.)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Unsupported get request.", code: 100 } }, 400),
    );

    await expect(downloadMedia({ accessToken: "token-test" }, "media-inexistente")).rejects.toThrow(
      /Meta rechazó la consulta del media/,
    );
  });

  it("lanza si la descarga de los bytes falla (URL temporal ya expiró)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ url: "https://lookaside.fbsbx.com/temp/expirada", mime_type: "image/jpeg" }))
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response);

    await expect(downloadMedia({ accessToken: "token-test" }, "media-id-789")).rejects.toThrow(/HTTP 404/);
  });

  it("lanza si no hay accessToken en las credenciales", async () => {
    await expect(downloadMedia({}, "media-id-000")).rejects.toThrow(/accessToken/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
