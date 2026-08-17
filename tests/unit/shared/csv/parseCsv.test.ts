import { describe, expect, it } from "vitest";
import { parseCsv } from "../../../../src/shared/csv/parseCsv.js";

describe("parseCsv", () => {
  it("parsea encabezado y filas simples separadas por coma", () => {
    const result = parseCsv("sku,name,price,stock\nABC-1,Casco,100000,5\nABC-2,Guantes,50000,10");
    expect(result.headers).toEqual(["sku", "name", "price", "stock"]);
    expect(result.rows).toEqual([
      { sku: "ABC-1", name: "Casco", price: "100000", stock: "5" },
      { sku: "ABC-2", name: "Guantes", price: "50000", stock: "10" },
    ]);
  });

  it("soporta campos entre comillas con comas embebidas", () => {
    const result = parseCsv('sku,name,price,stock\nABC-1,"Casco, talla M",100000,5');
    expect(result.rows[0]).toEqual({ sku: "ABC-1", name: "Casco, talla M", price: "100000", stock: "5" });
  });

  it("soporta comillas escapadas dentro de un campo entre comillas", () => {
    const result = parseCsv('sku,name,price,stock\nABC-1,"Casco ""Pro""",100000,5');
    expect(result.rows[0]!.name).toBe('Casco "Pro"');
  });

  it("ignora líneas en blanco", () => {
    const result = parseCsv("sku,name,price,stock\n\nABC-1,Casco,100000,5\n\n");
    expect(result.rows).toHaveLength(1);
  });

  it("devuelve vacío si el texto está vacío", () => {
    const result = parseCsv("");
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
  });
});
