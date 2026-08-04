import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recomendarProducto } from "../../../src/domains/commerce/recomendarProducto.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { deleteProduct, seedProduct } from "../../helpers/seedCatalog.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let cascoCategoryId: string;
let guantesCategoryId: string;
let casco: string;
let guantesConStock: string;
let guantesSinStock: string;
let productoSinCategoria: string;

beforeAll(async () => {
  // Categorías propias de este test (no las del catálogo de prueba real)
  // + su fila en category_complements — reemplaza el viejo mapa hardcodeado
  // COMPLEMENTARY_CATEGORIES que comparaba texto (ver ADR-026, Fase 14).
  const cascoCategory = await adminPool.query<{ id: string }>(
    `INSERT INTO product_categories (name) VALUES ('Cascos test recomendación') RETURNING id`,
  );
  cascoCategoryId = cascoCategory.rows[0]!.id;
  const guantesCategory = await adminPool.query<{ id: string }>(
    `INSERT INTO product_categories (name) VALUES ('Guantes test recomendación') RETURNING id`,
  );
  guantesCategoryId = guantesCategory.rows[0]!.id;
  await adminPool.query(
    `INSERT INTO category_complements (category_id, complementary_category_id) VALUES ($1, $2), ($2, $1)`,
    [cascoCategoryId, guantesCategoryId],
  );

  const cascoSeed = await seedProduct(adminPool, {
    sku: "CASCO-REC",
    name: "Casco recomendación",
    price: 300000,
    stock: 5,
    categoryId: cascoCategoryId,
  });
  casco = cascoSeed.productId;

  const guantesConStockSeed = await seedProduct(adminPool, {
    sku: "GUANTES-REC",
    name: "Guantes recomendación",
    price: 50000,
    stock: 10,
    categoryId: guantesCategoryId,
  });
  guantesConStock = guantesConStockSeed.productId;

  const guantesSinStockSeed = await seedProduct(adminPool, {
    sku: "GUANTES-REC-2",
    name: "Guantes sin stock",
    price: 45000,
    stock: 0,
    categoryId: guantesCategoryId,
  });
  guantesSinStock = guantesSinStockSeed.productId;

  const sinCategoriaSeed = await seedProduct(adminPool, {
    sku: "ACC-SIN-CAT",
    name: "Accesorio sin categoría",
    price: 10000,
    stock: 5,
  });
  productoSinCategoria = sinCategoriaSeed.productId;
});

afterAll(async () => {
  const productIds = [casco, guantesConStock, guantesSinStock, productoSinCategoria];
  for (const productId of productIds) {
    await deleteProduct(adminPool, productId);
  }
  await adminPool.query(
    `DELETE FROM category_complements WHERE category_id = ANY($1) OR complementary_category_id = ANY($1)`,
    [[cascoCategoryId, guantesCategoryId]],
  );
  await adminPool.query(`DELETE FROM product_categories WHERE id = ANY($1)`, [
    [cascoCategoryId, guantesCategoryId],
  ]);
  await adminPool.end();
  await appPool.end();
});

describe("recomendarProducto", () => {
  it("recomienda productos de categorías complementarias con stock, usando category_complements", async () => {
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
