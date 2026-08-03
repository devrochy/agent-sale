import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consultarInventario } from "../../../src/domains/catalog/consultarInventario.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let productId: string;

beforeAll(async () => {
  const product = await adminPool.query<{ id: string }>(
    `INSERT INTO products (sku, name, price, description, image_url)
     VALUES ('CASCO-A', 'Casco integral A', 300000, 'Casco integral con visor antirayas', 'https://picsum.photos/seed/CASCO-A/600/400')
     RETURNING id`,
  );
  productId = product.rows[0]!.id;
  await adminPool.query(`INSERT INTO inventory (product_id, stock_quantity) VALUES ($1, 7)`, [
    productId,
  ]);
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM inventory WHERE product_id = $1`, [productId]);
  await adminPool.query(`DELETE FROM products WHERE id = $1`, [productId]);
  await adminPool.end();
  await appPool.end();
});

describe("consultarInventario", () => {
  it("encuentra un producto por término de búsqueda", async () => {
    const result = await consultarInventario({ query: "Casco integral A" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ sku: "CASCO-A", name: "Casco integral A", stock: 7 });
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
