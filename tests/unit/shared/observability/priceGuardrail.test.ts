import { describe, expect, it } from "vitest";
import {
  extractCurrencyAmountsFromText,
  extractMonetaryValues,
  extractStockClaimsFromText,
  extractStockValues,
  verifyPriceGuardrail,
  verifyStockGuardrail,
} from "../../../../src/shared/observability/priceGuardrail.js";

describe("extractMonetaryValues", () => {
  it("recolecta números bajo claves de dinero conocidas, incluso anidados", () => {
    const output = {
      quote_id: "q-1",
      items: [
        { product_id: "p-1", unit_price: 50000, line_total: 100000, quantity: 2 },
        { product_id: "p-2", unit_price: 30000, line_total: 30000, quantity: 1 },
      ],
      subtotal: 130000,
      discount: 13000,
      total: 117000,
      status: "draft",
    };

    expect(extractMonetaryValues(output)).toEqual([
      50000, 100000, 30000, 30000, 130000, 13000, 117000,
    ]);
  });

  it("ignora claves que no son de dinero (stock, quantity, ids)", () => {
    const output = { matches: [{ product_id: "p-1", price: 45000, stock: 12 }] };

    expect(extractMonetaryValues(output)).toEqual([45000]);
  });

  it("devuelve vacío si no hay claves de dinero", () => {
    expect(extractMonetaryValues({ status: "queued", assigned_to: null })).toEqual([]);
  });
});

describe("extractCurrencyAmountsFromText", () => {
  it("extrae montos con formato colombiano ($X.XXX)", () => {
    expect(extractCurrencyAmountsFromText("El casco cuesta $300.000")).toEqual([300000]);
  });

  it("extrae montos con decimales ($X.XXX,XX)", () => {
    expect(extractCurrencyAmountsFromText("Total: $1.500.000,50")).toEqual([1500000.5]);
  });

  it("extrae varios montos del mismo texto", () => {
    expect(extractCurrencyAmountsFromText("Subtotal $100.000, descuento $10.000, total $90.000")).toEqual([
      100000, 10000, 90000,
    ]);
  });

  it("devuelve vacío si el texto no menciona montos con $", () => {
    expect(extractCurrencyAmountsFromText("Tenemos 5 unidades en stock del casco talla M")).toEqual([]);
  });
});

describe("verifyPriceGuardrail", () => {
  it("aprueba si todos los montos del texto coinciden con montos reales", () => {
    const result = verifyPriceGuardrail("El total de tu pedido es $117.000", [117000, 130000]);
    expect(result).toEqual({ ok: true, mismatched: [] });
  });

  it("rechaza si algún monto del texto no coincide con ningún monto real", () => {
    const result = verifyPriceGuardrail("El total de tu pedido es $17.000", [117000, 130000]);
    expect(result.ok).toBe(false);
    expect(result.mismatched).toEqual([17000]);
  });

  it("tolera diferencias de redondeo flotante", () => {
    const result = verifyPriceGuardrail("Total: $90.000", [90000.004]);
    expect(result).toEqual({ ok: true, mismatched: [] });
  });
});

describe("extractStockValues", () => {
  it("recolecta números bajo la clave stock, incluso anidados", () => {
    const output = {
      matches: [
        { product_id: "p-1", price: 45000, stock: 12 },
        { product_id: "p-2", price: 30000, stock: 0 },
      ],
    };
    expect(extractStockValues(output)).toEqual([12, 0]);
  });

  it("ignora claves que no son de stock (price, quantity, ids)", () => {
    const output = { quote_id: "q-1", items: [{ quantity: 2, unit_price: 50000 }] };
    expect(extractStockValues(output)).toEqual([]);
  });
});

describe("extractStockClaimsFromText", () => {
  it("extrae cantidades con el formato exacto 'Quedan N'", () => {
    expect(extractStockClaimsFromText("Quedan 12 en stock.")).toEqual([12]);
  });

  it("extrae 'Quedan N unidades'", () => {
    expect(extractStockClaimsFromText("Quedan 5 unidades disponibles.")).toEqual([5]);
  });

  it("extrae varias afirmaciones del mismo texto", () => {
    expect(extractStockClaimsFromText("Del casco quedan 12, de los guantes quedan 3.")).toEqual([12, 3]);
  });

  it("no confunde cantidades pedidas por el cliente ni SKUs con afirmaciones de stock", () => {
    expect(extractStockClaimsFromText("Perfecto, te separo 2 cascos del modelo CAS-005.")).toEqual([]);
  });
});

describe("verifyStockGuardrail", () => {
  it("aprueba si la cantidad afirmada coincide con el stock real devuelto por una tool", () => {
    const result = verifyStockGuardrail("Quedan 12 unidades.", [12, 0]);
    expect(result).toEqual({ ok: true, mismatched: [] });
  });

  it("rechaza si la cantidad afirmada no coincide con ningún stock real", () => {
    const result = verifyStockGuardrail("Quedan 50 unidades.", [12, 0]);
    expect(result.ok).toBe(false);
    expect(result.mismatched).toEqual([50]);
  });

  it("aprueba un texto sin afirmaciones de stock", () => {
    const result = verifyStockGuardrail("¿Con qué método de pago vas a confirmar el pedido?", [12]);
    expect(result).toEqual({ ok: true, mismatched: [] });
  });
});
