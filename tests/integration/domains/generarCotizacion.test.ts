import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let tenantA: string;
let tenantB: string;
let conversationA: string;
let customerA: string;
let productA: string;
let productB: string;

beforeAll(async () => {
  const a = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Generar Cotizacion Test A') RETURNING id`,
  );
  tenantA = a.rows[0]!.id;
  const b = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Generar Cotizacion Test B') RETURNING id`,
  );
  tenantB = b.rows[0]!.id;

  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, phone_number) VALUES ($1, '3020000001') RETURNING id`,
    [tenantA],
  );
  customerA = customer.rows[0]!.id;
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id`,
    [tenantA, customerA],
  );
  conversationA = conversation.rows[0]!.id;

  const product = await adminPool.query<{ id: string }>(
    `INSERT INTO products (tenant_id, sku, name, price) VALUES ($1, 'CASCO-COT', 'Casco cotización', 100000) RETURNING id`,
    [tenantA],
  );
  productA = product.rows[0]!.id;
  await adminPool.query(
    `INSERT INTO inventory (tenant_id, product_id, stock_quantity) VALUES ($1, $2, 10)`,
    [tenantA, productA],
  );

  const productOtherTenant = await adminPool.query<{ id: string }>(
    `INSERT INTO products (tenant_id, sku, name, price) VALUES ($1, 'CASCO-COT-B', 'Casco tenant B', 50000) RETURNING id`,
    [tenantB],
  );
  productB = productOtherTenant.rows[0]!.id;
  await adminPool.query(
    `INSERT INTO inventory (tenant_id, product_id, stock_quantity) VALUES ($1, $2, 5)`,
    [tenantB, productB],
  );
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM quote_items WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM quotes WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM inventory WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM products WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM conversations WHERE tenant_id IN ($1, $2)`, [
    tenantA,
    tenantB,
  ]);
  await adminPool.query(`DELETE FROM customers WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.end();
  await appPool.end();
});

describe("generarCotizacion", () => {
  it("crea una cotización con subtotal calculado a partir del precio real", async () => {
    const result = await generarCotizacion(tenantA, conversationA, customerA, {
      items: [{ product_id: productA, quantity: 3 }],
    });

    expect(result.status).toBe("draft");
    expect(result.subtotal).toBe(300000);
    expect(result.items).toEqual([
      {
        product_id: productA,
        name: "Casco cotización",
        quantity: 3,
        unit_price: 100000,
        line_total: 300000,
      },
    ]);

    const row = await adminPool.query(`SELECT subtotal, total, status FROM quotes WHERE id = $1`, [
      result.quote_id,
    ]);
    expect(Number(row.rows[0].subtotal)).toBe(300000);
    expect(Number(row.rows[0].total)).toBe(300000);
    expect(row.rows[0].status).toBe("draft");
  });

  it("falla si el stock no alcanza para la cantidad pedida", async () => {
    await expect(
      generarCotizacion(tenantA, conversationA, customerA, {
        items: [{ product_id: productA, quantity: 999 }],
      }),
    ).rejects.toThrow(/Stock insuficiente/);
  });

  it("falla si el producto no existe (o pertenece a otro tenant, oculto por RLS)", async () => {
    await expect(
      generarCotizacion(tenantA, conversationA, customerA, {
        items: [{ product_id: productB, quantity: 1 }],
      }),
    ).rejects.toThrow(/Producto no encontrado/);
  });

  it("falla si la lista de items está vacía", async () => {
    await expect(
      generarCotizacion(tenantA, conversationA, customerA, { items: [] }),
    ).rejects.toThrow();
  });
});
