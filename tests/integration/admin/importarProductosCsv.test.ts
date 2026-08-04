import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importarProductosCsv } from "../../../src/admin/adminPanel.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let allyId: string;
const productIds: string[] = [];

beforeAll(async () => {
  const ally = await adminPool.query<{ id: string }>(
    `INSERT INTO allies (name) VALUES ('Aliado Test Import CSV') RETURNING id`,
  );
  allyId = ally.rows[0]!.id;

  // Variante preexistente para probar la rama de "actualizar" (no crear).
  const product = await adminPool.query<{ id: string }>(
    `INSERT INTO products (ally_id, name) VALUES ($1, 'Producto CSV preexistente') RETURNING id`,
    [allyId],
  );
  productIds.push(product.rows[0]!.id);
  const variant = await adminPool.query<{ id: string }>(
    `INSERT INTO product_variants (product_id, sku, price) VALUES ($1, 'CSV-EXISTENTE', 10000) RETURNING id`,
    [product.rows[0]!.id],
  );
  await adminPool.query(`INSERT INTO inventory (variant_id, stock_quantity) VALUES ($1, 2)`, [
    variant.rows[0]!.id,
  ]);
});

afterAll(async () => {
  const nuevo = await adminPool.query<{ id: string }>(
    `SELECT product_id AS id FROM product_variants WHERE sku = 'CSV-NUEVO-1'`,
  );
  for (const row of [...productIds, ...nuevo.rows.map((r) => r.id)]) {
    await adminPool.query(
      `DELETE FROM inventory WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)`,
      [row],
    );
    await adminPool.query(`DELETE FROM product_variants WHERE product_id = $1`, [row]);
    await adminPool.query(`DELETE FROM products WHERE id = $1`, [row]);
  }
  await adminPool.query(`DELETE FROM allies WHERE id = $1`, [allyId]);
  await adminPool.end();
  await appPool.end();
});

describe("importarProductosCsv", () => {
  it("actualiza precio/stock de un SKU existente y crea uno nuevo, sin abortar por una fila con error", async () => {
    const csv = [
      "sku,name,price,stock,talla,color",
      "CSV-EXISTENTE,Nombre ignorado,15000,9,,",
      "CSV-NUEVO-1,Producto CSV nuevo,30000,4,M,rojo",
      "CSV-SIN-PRECIO,Producto sin precio,no-es-un-numero,4,,",
    ].join("\n");

    const resultado = await importarProductosCsv(allyId, csv);

    expect(resultado.creados).toBe(1);
    expect(resultado.actualizados).toBe(1);
    expect(resultado.errores).toHaveLength(1);
    expect(resultado.errores[0]!.message).toContain("CSV-SIN-PRECIO");

    const existente = await adminPool.query<{ price: string; name: string }>(
      `SELECT pv.price, p.name FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE pv.sku = 'CSV-EXISTENTE'`,
    );
    expect(Number(existente.rows[0]!.price)).toBe(15000);
    // El SKU existente no cambia de nombre por la carga masiva (solo precio/stock).
    expect(existente.rows[0]!.name).toBe("Producto CSV preexistente");

    const stockExistente = await adminPool.query<{ stock_quantity: number }>(
      `SELECT i.stock_quantity FROM inventory i JOIN product_variants pv ON pv.id = i.variant_id WHERE pv.sku = 'CSV-EXISTENTE'`,
    );
    expect(stockExistente.rows[0]!.stock_quantity).toBe(9);

    const nuevo = await adminPool.query<{ attributes: Record<string, unknown>; ally_id: string }>(
      `SELECT pv.attributes, p.ally_id FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE pv.sku = 'CSV-NUEVO-1'`,
    );
    expect(nuevo.rows[0]!.attributes).toEqual({ talla: "M", color: "rojo" });
    expect(nuevo.rows[0]!.ally_id).toBe(allyId);
  });
});
