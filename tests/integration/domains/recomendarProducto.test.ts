import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recomendarProducto } from "../../../src/domains/commerce/recomendarProducto.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let tenantA: string;
let tenantB: string;
let casco: string;
let guantesConStock: string;
let guantesSinStock: string;
let productoSinCategoria: string;

beforeAll(async () => {
  const a = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Recomendar Producto Test A') RETURNING id`,
  );
  tenantA = a.rows[0]!.id;
  const b = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Recomendar Producto Test B') RETURNING id`,
  );
  tenantB = b.rows[0]!.id;

  const cascoRow = await adminPool.query<{ id: string }>(
    `INSERT INTO products (tenant_id, sku, name, category, price) VALUES ($1, 'CASCO-REC', 'Casco recomendación', 'casco', 300000) RETURNING id`,
    [tenantA],
  );
  casco = cascoRow.rows[0]!.id;

  const guantesConStockRow = await adminPool.query<{ id: string }>(
    `INSERT INTO products (tenant_id, sku, name, category, price) VALUES ($1, 'GUANTES-REC', 'Guantes recomendación', 'guantes', 50000) RETURNING id`,
    [tenantA],
  );
  guantesConStock = guantesConStockRow.rows[0]!.id;
  await adminPool.query(
    `INSERT INTO inventory (tenant_id, product_id, stock_quantity) VALUES ($1, $2, 10)`,
    [tenantA, guantesConStock],
  );

  const guantesSinStockRow = await adminPool.query<{ id: string }>(
    `INSERT INTO products (tenant_id, sku, name, category, price) VALUES ($1, 'GUANTES-REC-2', 'Guantes sin stock', 'guantes', 45000) RETURNING id`,
    [tenantA],
  );
  guantesSinStock = guantesSinStockRow.rows[0]!.id;
  await adminPool.query(
    `INSERT INTO inventory (tenant_id, product_id, stock_quantity) VALUES ($1, $2, 0)`,
    [tenantA, guantesSinStock],
  );

  const sinCategoriaRow = await adminPool.query<{ id: string }>(
    `INSERT INTO products (tenant_id, sku, name, price) VALUES ($1, 'ACC-SIN-CAT', 'Accesorio sin categoría', 10000) RETURNING id`,
    [tenantA],
  );
  productoSinCategoria = sinCategoriaRow.rows[0]!.id;
});

afterAll(async () => {
  const tenantIds = [tenantA, tenantB];
  await adminPool.query(`DELETE FROM inventory WHERE tenant_id = ANY($1)`, [tenantIds]);
  await adminPool.query(`DELETE FROM products WHERE tenant_id = ANY($1)`, [tenantIds]);
  await adminPool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenantIds]);
  await adminPool.end();
  await appPool.end();
});

describe("recomendarProducto", () => {
  it("recomienda productos de categorías complementarias con stock, usando la regla de complementariedad", async () => {
    const result = await recomendarProducto(tenantA, { product_id: casco });

    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      product_id: guantesConStock,
      name: "Guantes recomendación",
      price: 50000,
      reason: "Frecuentemente comprado junto con Casco recomendación",
    });
  });

  it("nunca recomienda un producto sin stock", async () => {
    const result = await recomendarProducto(tenantA, { product_id: casco });

    expect(result.recommendations.some((r) => r.product_id === guantesSinStock)).toBe(false);
  });

  it("devuelve vacío si el producto de referencia no tiene categoría", async () => {
    const result = await recomendarProducto(tenantA, { product_id: productoSinCategoria });
    expect(result.recommendations).toEqual([]);
  });

  it("devuelve vacío si no hay product_id de referencia (ruta de embeddings pendiente, ver ADR-010)", async () => {
    const result = await recomendarProducto(tenantA, {
      context: "el cliente pregunta por accesorios",
    });
    expect(result.recommendations).toEqual([]);
  });

  it("no recomienda productos de otro tenant", async () => {
    const result = await recomendarProducto(tenantA, { product_id: casco });
    expect(result.recommendations.every((r) => r.product_id !== "otro-tenant")).toBe(true);
    // Aislamiento real: bajo la sesión de tenantB, el producto casco de
    // tenantA no es visible (RLS), así que no hay forma de referenciarlo.
    await expect(recomendarProducto(tenantB, { product_id: casco })).resolves.toEqual({
      recommendations: [],
    });
  });
});
