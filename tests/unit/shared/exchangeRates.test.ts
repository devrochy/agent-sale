import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertFromUsd, formatMoney, isCurrency } from "../../../src/shared/exchangeRates.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("isCurrency", () => {
  it("acepta las monedas soportadas y rechaza el resto", () => {
    expect(isCurrency("COP")).toBe(true);
    expect(isCurrency("USD")).toBe(true);
    expect(isCurrency("EUR")).toBe(false);
    expect(isCurrency("")).toBe(false);
  });
});

describe("convertFromUsd", () => {
  it("USD no requiere tasas, devuelve el monto tal cual", () => {
    expect(convertFromUsd(1.5, "USD", null)).toBe(1.5);
  });

  it("convierte con la tasa provista", () => {
    expect(convertFromUsd(2, "COP", { COP: 4000 })).toBe(8000);
  });

  it("sin tasa disponible para la moneda pedida devuelve null, no asume 1:1", () => {
    expect(convertFromUsd(2, "COP", { MXN: 18 })).toBeNull();
    expect(convertFromUsd(2, "COP", null)).toBeNull();
  });
});

describe("formatMoney", () => {
  it("USD usa 2 decimales normalmente y 4 si el monto real es menor a 1", () => {
    expect(formatMoney(5, "USD")).toBe("$5.00");
    expect(formatMoney(0.0018, "USD")).toBe("$0.0018");
  });

  it("COP no usa decimales, formato es-CO, y agrega el código de moneda para no confundirse con USD", () => {
    expect(formatMoney(7240, "COP")).toBe("$7.240 COP");
  });

  it("un monto en COP menor a 1 (caso raro, tasas muy bajas) igual muestra precisión, no $0", () => {
    expect(formatMoney(0.5, "COP")).toBe("$0,5000 COP");
  });
});

describe("getUsdExchangeRates", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("devuelve las tasas del endpoint cuando la respuesta es exitosa", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ result: "success", rates: { COP: 4000, MXN: 18 } }),
    );
    const { getUsdExchangeRates: getRates } = await import("../../../src/shared/exchangeRates.js");

    const rates = await getRates();

    expect(rates).toEqual({ COP: 4000, MXN: 18 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cachea en memoria — una segunda llamada no vuelve a golpear la red", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ result: "success", rates: { COP: 4000 } }));
    const { getUsdExchangeRates: getRates } = await import("../../../src/shared/exchangeRates.js");

    await getRates();
    await getRates();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("si el fetch falla y nunca hubo caché, devuelve null en vez de lanzar", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));
    const { getUsdExchangeRates: getRates } = await import("../../../src/shared/exchangeRates.js");

    await expect(getRates()).resolves.toBeNull();
  });

  it("si el fetch falla pero ya había tasas en caché, devuelve el último valor conocido", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: "success", rates: { COP: 4000 } }));
    const { getUsdExchangeRates: getRates } = await import("../../../src/shared/exchangeRates.js");

    const first = await getRates();
    expect(first).toEqual({ COP: 4000 });

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 13 * 60 * 60 * 1000);
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const second = await getRates();
    expect(second).toEqual({ COP: 4000 });
    vi.restoreAllMocks();
  });
});
