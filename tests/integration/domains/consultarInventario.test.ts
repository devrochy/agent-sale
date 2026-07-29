import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consultarInventario } from "../../../src/domains/catalog/consultarInventario.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  const a = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Consultar Inventario Test A') RETURNING id`,
  );
  tenantA = a.rows[0]!.id;
  const b = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Consultar Inventario Test B') RETURNING id`,
  );
  tenantB = b.rows[0]!.id;

  const productA = await adminPool.query<{ id: string }>(
    `INSERT INTO products (tenant_id, sku, name, price, description, image_url)
     VALUES ($1, 'CASCO-A', 'Casco integral A', 300000, 'Casco integral con visor antirayas', 'https://picsum.photos/seed/CASCO-A/600/400')
     RETURNING id`,
    [tenantA],
  );
  await adminPool.query(
    `INSERT INTO inventory (tenant_id, product_id, stock_quantity) VALUES ($1, $2, 7)`,
    [tenantA, productA.rows[0]!.id],
  );

  const productB = await adminPool.query<{ id: string }>(
    `INSERT INTO products (tenant_id, sku, name, price) VALUES ($1, 'CASCO-B', 'Casco integral B', 280000) RETURNING id`,
    [tenantB],
  );
  await adminPool.query(
    `INSERT INTO inventory (tenant_id, product_id, stock_quantity) VALUES ($1, $2, 3)`,
    [tenantB, productB.rows[0]!.id],
  );
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM inventory WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM products WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.end();
  await appPool.end();
});

describe("consultarInventario", () => {
  it("encuentra un producto por término de búsqueda dentro del propio tenant", async () => {
    const result = await consultarInventario(tenantA, { query: "Casco integral A" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ sku: "CASCO-A", name: "Casco integral A", stock: 7 });
    expect(result.matches[0]!.price).toBe(300000);
  });

  it("incluye description e image_url del producto", async () => {
    const result = await consultarInventario(tenantA, { sku: "CASCO-A" });
    expect(result.matches[0]).toMatchObject({
      description: "Casco integral con visor antirayas",
      image_url: "https://picsum.photos/seed/CASCO-A/600/400",
    });
  });

  it("encuentra un producto por SKU exacto", async () => {
    const result = await consultarInventario(tenantA, { sku: "CASCO-A" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.sku).toBe("CASCO-A");
  });

  it("no devuelve productos de otro tenant aunque el término coincida", async () => {
    const result = await consultarInventario(tenantA, { query: "Casco integral" });
    expect(result.matches.every((m) => m.sku !== "CASCO-B")).toBe(true);
  });

  it("devuelve vacío si no hay coincidencias", async () => {
    const result = await consultarInventario(tenantA, { query: "producto-que-no-existe" });
    expect(result.matches).toHaveLength(0);
  });
});
