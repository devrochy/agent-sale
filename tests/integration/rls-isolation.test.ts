import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { withTenant } from "../../src/shared/db/withTenant.js";
import { pool as appPool } from "../../src/shared/db/pool.js";

const { Pool } = pg;

// Conexión admin (rol de migraciones) solo para sembrar/limpiar datos de
// prueba cruzando tenants — el propio test usa `withTenant` (rol de
// aplicación) para verificar el aislamiento real, ver migrations/0011.
const adminPool = new Pool({
  connectionString: process.env.MIGRATIONS_DATABASE_URL,
});

let tenantA: string;
let tenantB: string;
let customerB: string;
let productB: string;
let orderB: string;

beforeAll(async () => {
  const tenantARes = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('RLS Test Tenant A') RETURNING id`,
  );
  tenantA = tenantARes.rows[0]!.id;

  const tenantBRes = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('RLS Test Tenant B') RETURNING id`,
  );
  tenantB = tenantBRes.rows[0]!.id;

  const customerBRes = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, phone_number) VALUES ($1, '3000000001') RETURNING id`,
    [tenantB],
  );
  customerB = customerBRes.rows[0]!.id;

  const conversationBRes = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id`,
    [tenantB, customerB],
  );
  const conversationB = conversationBRes.rows[0]!.id;

  const productBRes = await adminPool.query<{ id: string }>(
    `INSERT INTO products (tenant_id, sku, name, price)
     VALUES ($1, 'SKU-B-TEST', 'Producto Tenant B', 100000)
     RETURNING id`,
    [tenantB],
  );
  productB = productBRes.rows[0]!.id;

  const quoteBRes = await adminPool.query<{ id: string }>(
    `INSERT INTO quotes (tenant_id, conversation_id, customer_id, subtotal, total)
     VALUES ($1, $2, $3, 100000, 100000)
     RETURNING id`,
    [tenantB, conversationB, customerB],
  );
  const quoteB = quoteBRes.rows[0]!.id;

  const orderBRes = await adminPool.query<{ id: string }>(
    `INSERT INTO orders
       (tenant_id, quote_id, conversation_id, customer_id, payment_method, delivery_method, idempotency_key, total)
     VALUES ($1, $2, $3, $4, 'transferencia', 'domicilio', 'rls-test-idem-1', 100000)
     RETURNING id`,
    [tenantB, quoteB, conversationB, customerB],
  );
  orderB = orderBRes.rows[0]!.id;
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM order_items WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM orders WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM quote_items WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM quotes WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM messages WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM conversations WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM inventory WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM products WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM customers WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.end();
  await appPool.end();
});

describe("Aislamiento multi-tenant (RLS)", () => {
  it("tenant_a no puede leer productos de tenant_b", async () => {
    const result = await withTenant(tenantA, (client) =>
      client.query("SELECT * FROM products WHERE id = $1", [productB]),
    );
    expect(result.rows).toHaveLength(0);
  });

  it("tenant_a no puede leer pedidos de tenant_b", async () => {
    const result = await withTenant(tenantA, (client) =>
      client.query("SELECT * FROM orders WHERE id = $1", [orderB]),
    );
    expect(result.rows).toHaveLength(0);
  });

  it("tenant_a no puede modificar productos de tenant_b, incluso apuntando el id directamente", async () => {
    const result = await withTenant(tenantA, (client) =>
      client.query("UPDATE products SET price = 1 WHERE id = $1", [productB]),
    );
    expect(result.rowCount).toBe(0);

    const check = await adminPool.query("SELECT price FROM products WHERE id = $1", [productB]);
    expect(Number(check.rows[0].price)).toBe(100000);
  });

  it("tenant_a no puede borrar pedidos de tenant_b", async () => {
    const result = await withTenant(tenantA, (client) =>
      client.query("DELETE FROM orders WHERE id = $1", [orderB]),
    );
    expect(result.rowCount).toBe(0);
  });

  it("tenant_b sí puede leer su propio producto y pedido", async () => {
    const products = await withTenant(tenantB, (client) =>
      client.query("SELECT * FROM products WHERE id = $1", [productB]),
    );
    expect(products.rows).toHaveLength(1);

    const orders = await withTenant(tenantB, (client) =>
      client.query("SELECT * FROM orders WHERE id = $1", [orderB]),
    );
    expect(orders.rows).toHaveLength(1);
  });

  it("una sesión sin app.tenant_id seteado no ve ninguna fila (fail-closed)", async () => {
    const result = await appPool.query("SELECT * FROM products WHERE id = $1", [productB]);
    expect(result.rows).toHaveLength(0);
  });
});
