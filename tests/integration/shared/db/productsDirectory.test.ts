import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProduct,
  findVariantBySku,
  getProductDetail,
  listProductsSummary,
  updateProduct,
  updateVariantStockAndPrice,
} from "../../../../src/shared/db/productsDirectory.js";
import { pool as appPool } from "../../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let allyA: string;
let allyB: string;
let categoryA: string;
const productIds: string[] = [];

beforeAll(async () => {
  const ally = await adminPool.query<{ id: string }>(
    `INSERT INTO allies (name) VALUES ('Aliado Test Productos A') RETURNING id`,
  );
  allyA = ally.rows[0]!.id;
  const allyOther = await adminPool.query<{ id: string }>(
    `INSERT INTO allies (name) VALUES ('Aliado Test Productos B') RETURNING id`,
  );
  allyB = allyOther.rows[0]!.id;
  const category = await adminPool.query<{ id: string }>(
    `INSERT INTO product_categories (name) VALUES ('Categoría Test Productos') RETURNING id`,
  );
  categoryA = category.rows[0]!.id;
});

afterAll(async () => {
  for (const productId of productIds) {
    await adminPool.query(
      `DELETE FROM inventory WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)`,
      [productId],
    );
    await adminPool.query(`DELETE FROM product_variants WHERE product_id = $1`, [productId]);
    await adminPool.query(`DELETE FROM products WHERE id = $1`, [productId]);
  }
  await adminPool.query(`DELETE FROM product_categories WHERE id = $1`, [categoryA]);
  await adminPool.query(`DELETE FROM allies WHERE id = ANY($1)`, [[allyA, allyB]]);
  await adminPool.end();
  await appPool.end();
});

describe("productsDirectory", () => {
  it("crea un producto genérico con una sola variante (sin talla/color)", async () => {
    const productId = await createProduct({
      name: "Producto genérico test",
      description: "Descripción de prueba",
      imageUrl: null,
      allyId: allyA,
      categoryId: categoryA,
      variants: [{ sku: "PDT-GEN-001", attributes: {}, price: 50000, stock: 10 }],
    });
    productIds.push(productId);

    const detail = await getProductDetail(productId);
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe("Producto genérico test");
    expect(detail!.variants).toHaveLength(1);
    expect(detail!.variants[0]).toMatchObject({
      sku: "PDT-GEN-001",
      attributes: {},
      price: 50000,
      stock: 10,
      active: true,
    });

    const summary = await listProductsSummary({ allyId: allyA });
    const found = summary.find((p) => p.id === productId);
    expect(found).toMatchObject({ variantCount: 1, minPrice: 50000, maxPrice: 50000, totalStock: 10 });
  });

  it("crea un producto con varias variantes de talla", async () => {
    const productId = await createProduct({
      name: "Casco con tallas test",
      description: null,
      imageUrl: null,
      allyId: allyA,
      categoryId: categoryA,
      variants: [
        { sku: "PDT-TALLA-S", attributes: { talla: "S" }, price: 100000, stock: 3 },
        { sku: "PDT-TALLA-M", attributes: { talla: "M" }, price: 100000, stock: 5 },
        { sku: "PDT-TALLA-L", attributes: { talla: "L" }, price: 110000, stock: 2 },
      ],
    });
    productIds.push(productId);

    const detail = await getProductDetail(productId);
    expect(detail!.variants).toHaveLength(3);
    expect(detail!.variants.map((v) => v.attributes.talla).sort()).toEqual(["L", "M", "S"]);

    const summary = await listProductsSummary({ allyId: allyA });
    const found = summary.find((p) => p.id === productId);
    expect(found).toMatchObject({ variantCount: 3, minPrice: 100000, maxPrice: 110000, totalStock: 10 });
  });

  it("agrega una variante nueva a un producto ya existente", async () => {
    const productId = await createProduct({
      name: "Producto para agregar variante",
      description: null,
      imageUrl: null,
      allyId: allyA,
      categoryId: null,
      variants: [{ sku: "PDT-AGREGAR-1", attributes: {}, price: 20000, stock: 4 }],
    });
    productIds.push(productId);

    const before = await getProductDetail(productId);
    await updateProduct(productId, {
      name: before!.name,
      description: before!.description,
      imageUrl: before!.imageUrl,
      allyId: before!.allyId,
      categoryId: before!.categoryId,
      variants: [
        { id: before!.variants[0]!.id, sku: "PDT-AGREGAR-1", attributes: {}, price: 20000, stock: 4, active: true },
        { id: null, sku: "PDT-AGREGAR-2", attributes: { color: "rojo" }, price: 22000, stock: 6, active: true },
      ],
    });

    const after = await getProductDetail(productId);
    expect(after!.variants).toHaveLength(2);
    const nueva = after!.variants.find((v) => v.sku === "PDT-AGREGAR-2");
    expect(nueva).toMatchObject({ attributes: { color: "rojo" }, price: 22000, stock: 6, active: true });
  });

  it("desactiva una variante sin borrarla — deja de contar en el resumen pero sigue en el detalle", async () => {
    const productId = await createProduct({
      name: "Producto para desactivar variante",
      description: null,
      imageUrl: null,
      allyId: allyA,
      categoryId: null,
      variants: [
        { sku: "PDT-DESACT-1", attributes: { talla: "S" }, price: 30000, stock: 1 },
        { sku: "PDT-DESACT-2", attributes: { talla: "M" }, price: 30000, stock: 1 },
      ],
    });
    productIds.push(productId);

    const before = await getProductDetail(productId);
    const toDeactivate = before!.variants.find((v) => v.sku === "PDT-DESACT-2")!;
    await updateProduct(productId, {
      name: before!.name,
      description: before!.description,
      imageUrl: before!.imageUrl,
      allyId: before!.allyId,
      categoryId: before!.categoryId,
      variants: before!.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        attributes: v.attributes,
        price: v.price,
        stock: v.stock,
        active: v.id === toDeactivate.id ? false : v.active,
      })),
    });

    const after = await getProductDetail(productId);
    expect(after!.variants).toHaveLength(2);
    expect(after!.variants.find((v) => v.sku === "PDT-DESACT-2")!.active).toBe(false);

    const summary = await listProductsSummary({ allyId: allyA });
    const found = summary.find((p) => p.id === productId);
    expect(found!.variantCount).toBe(1);
  });

  it("listProductsSummary filtra correctamente por aliado", async () => {
    const productId = await createProduct({
      name: "Producto del aliado B",
      description: null,
      imageUrl: null,
      allyId: allyB,
      categoryId: null,
      variants: [{ sku: "PDT-ALLYB-1", attributes: {}, price: 15000, stock: 2 }],
    });
    productIds.push(productId);

    const summaryB = await listProductsSummary({ allyId: allyB });
    expect(summaryB.some((p) => p.id === productId)).toBe(true);

    const summaryA = await listProductsSummary({ allyId: allyA });
    expect(summaryA.some((p) => p.id === productId)).toBe(false);
  });

  it("findVariantBySku y updateVariantStockAndPrice (soporte de la carga masiva CSV)", async () => {
    const productId = await createProduct({
      name: "Producto para CSV test",
      description: null,
      imageUrl: null,
      allyId: allyA,
      categoryId: null,
      variants: [{ sku: "PDT-CSV-1", attributes: {}, price: 40000, stock: 5 }],
    });
    productIds.push(productId);

    const found = await findVariantBySku("PDT-CSV-1");
    expect(found).toMatchObject({ productId });
    expect(await findVariantBySku("PDT-CSV-NO-EXISTE")).toBeNull();

    await updateVariantStockAndPrice(found!.id, 45000, 8);
    const detail = await getProductDetail(productId);
    expect(detail!.variants[0]).toMatchObject({ price: 45000, stock: 8 });
  });
});
