import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consultarInventario } from "../../../src/domains/catalog/consultarInventario.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { deleteProduct, seedProduct } from "../../helpers/seedCatalog.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let productId: string;
let variantId: string;

beforeAll(async () => {
  const seeded = await seedProduct(adminPool, {
    sku: "CASCO-A",
    name: "Casco integral A",
    price: 300000,
    stock: 7,
  });
  productId = seeded.productId;
  variantId = seeded.variantId;
  await adminPool.query(`UPDATE products SET description = $1, image_url = $2 WHERE id = $3`, [
    "Casco integral con visor antirayas",
    "https://picsum.photos/seed/CASCO-A/600/400",
    productId,
  ]);
});

afterAll(async () => {
  await deleteProduct(adminPool, productId);
  await adminPool.end();
  await appPool.end();
});

describe("consultarInventario", () => {
  it("encuentra un producto por término de búsqueda", async () => {
    const result = await consultarInventario({ query: "Casco integral A" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      product_id: productId,
      variant_id: variantId,
      sku: "CASCO-A",
      name: "Casco integral A",
      stock: 7,
    });
    expect(result.matches[0]!.price).toBe(300000);
  });

  it("incluye description e image_url del producto", async () => {
    const result = await consultarInventario({ sku: "CASCO-A" });
    expect(result.matches[0]).toMatchObject({
      description: "Casco integral con visor antirayas",
      image_url: "https://picsum.photos/seed/CASCO-A/600/400",
    });
  });

  it("encuentra un producto por SKU exacto", async () => {
    const result = await consultarInventario({ sku: "CASCO-A" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.sku).toBe("CASCO-A");
  });

  it("devuelve vacío si no hay coincidencias", async () => {
    const result = await consultarInventario({ query: "producto-que-no-existe" });
    expect(result.matches).toHaveLength(0);
  });
});
