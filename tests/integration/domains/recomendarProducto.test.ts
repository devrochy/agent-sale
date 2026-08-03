import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recomendarProducto } from "../../../src/domains/commerce/recomendarProducto.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let casco: string;
let guantesConStock: string;
let guantesSinStock: string;
let productoSinCategoria: string;

beforeAll(async () => {
  const cascoRow = await adminPool.query<{ id: string }>(
    `INSERT INTO products (sku, name, category, price) VALUES ('CASCO-REC', 'Casco recomendación', 'casco', 300000) RETURNING id`,
  );
  casco = cascoRow.rows[0]!.id;

  const guantesConStockRow = await adminPool.query<{ id: string }>(
    `INSERT INTO products (sku, name, category, price) VALUES ('GUANTES-REC', 'Guantes recomendación', 'guantes', 50000) RETURNING id`,
  );
  guantesConStock = guantesConStockRow.rows[0]!.id;
  await adminPool.query(`INSERT INTO inventory (product_id, stock_quantity) VALUES ($1, 10)`, [
    guantesConStock,
  ]);

  const guantesSinStockRow = await adminPool.query<{ id: string }>(
    `INSERT INTO products (sku, name, category, price) VALUES ('GUANTES-REC-2', 'Guantes sin stock', 'guantes', 45000) RETURNING id`,
  );
  guantesSinStock = guantesSinStockRow.rows[0]!.id;
  await adminPool.query(`INSERT INTO inventory (product_id, stock_quantity) VALUES ($1, 0)`, [
    guantesSinStock,
  ]);

  const sinCategoriaRow = await adminPool.query<{ id: string }>(
    `INSERT INTO products (sku, name, price) VALUES ('ACC-SIN-CAT', 'Accesorio sin categoría', 10000) RETURNING id`,
  );
  productoSinCategoria = sinCategoriaRow.rows[0]!.id;
});

afterAll(async () => {
  const productIds = [casco, guantesConStock, guantesSinStock, productoSinCategoria];
  await adminPool.query(`DELETE FROM inventory WHERE product_id = ANY($1)`, [productIds]);
  await adminPool.query(`DELETE FROM products WHERE id = ANY($1)`, [productIds]);
  await adminPool.end();
  await appPool.end();
});

describe("recomendarProducto", () => {
  it("recomienda productos de categorías complementarias con stock, usando la regla de complementariedad", async () => {
    const result = await recomendarProducto({ product_id: casco });

    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      product_id: guantesConStock,
      name: "Guantes recomendación",
      price: 50000,
      reason: "Frecuentemente comprado junto con Casco recomendación",
    });
  });

  it("nunca recomienda un producto sin stock", async () => {
    const result = await recomendarProducto({ product_id: casco });

    expect(result.recommendations.some((r) => r.product_id === guantesSinStock)).toBe(false);
  });

  it("devuelve vacío si el producto de referencia no tiene categoría", async () => {
    const result = await recomendarProducto({ product_id: productoSinCategoria });
    expect(result.recommendations).toEqual([]);
  });

  it("devuelve vacío si no hay product_id de referencia (ruta de embeddings pendiente, ver ADR-010)", async () => {
    const result = await recomendarProducto({ context: "el cliente pregunta por accesorios" });
    expect(result.recommendations).toEqual([]);
  });
});
