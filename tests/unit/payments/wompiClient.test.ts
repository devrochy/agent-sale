import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaymentLink } from "../../../src/payments/wompiClient.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("createPaymentLink", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("usa el host de sandbox para una llave prv_test_ y arma la URL de checkout", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ data: { id: "abc123" } }));

    const result = await createPaymentLink("prv_test_xxx", "Pedido de prueba", 1000);

    expect(result).toEqual({ paymentLinkId: "abc123", url: "https://checkout.wompi.co/l/abc123" });
    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("https://sandbox.wompi.co/v1/payment_links");
    expect((options as RequestInit).method).toBe("POST");
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer prv_test_xxx");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body).toMatchObject({
      description: "Pedido de prueba",
      single_use: true,
      collect_shipping: false,
      currency: "COP",
      amount_in_cents: 100000,
    });
  });

  it("usa el host de producción para una llave prv_prod_", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ data: { id: "xyz" } }));

    await createPaymentLink("prv_prod_xxx", "Pedido", 5000);

    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("https://production.wompi.co/v1/payment_links");
  });

  it("lanza con un prefijo de llave desconocido, sin llegar a llamar a fetch", async () => {
    await expect(createPaymentLink("clave_invalida", "Pedido", 1000)).rejects.toThrow(
      /prefijo desconocido/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lanza si Wompi rechaza la creación del link", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "unauthorized" }, false, 401));

    await expect(createPaymentLink("prv_test_xxx", "Pedido", 1000)).rejects.toThrow(/401/);
  });
});
