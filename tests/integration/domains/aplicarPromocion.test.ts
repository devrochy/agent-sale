import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aplicarPromocion } from "../../../src/domains/commerce/aplicarPromocion.js";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

// tenantA: promoción de volumen (dos tramos, sin solapar con la de temporada)
// + promoción de temporada, para probar "gana la de mayor beneficio" en
// ambas direcciones. tenantB: sin promociones, para el caso sin
// promoción aplicable. tenantC: solo promoción de producto gratis.
let tenantA: string;
let tenantB: string;
let tenantC: string;
let conversationA: string;
let customerA: string;
let conversationB: string;
let customerB: string;
let conversationC: string;
let customerC: string;
let productA: string;
let productB: string;
let productC: string;
let productGuantesC: string;

async function seedTenantContext(name: string, phone: string) {
  const tenant = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ($1) RETURNING id`,
    [name],
  );
  const tenantId = tenant.rows[0]!.id;
  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, phone_number) VALUES ($1, $2) RETURNING id`,
    [tenantId, phone],
  );
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id`,
    [tenantId, customer.rows[0]!.id],
  );
  return { tenantId, customerId: customer.rows[0]!.id, conversationId: conversation.rows[0]!.id };
}

beforeAll(async () => {
  const a = await seedTenantContext("Aplicar Promocion Test A", "3030000001");
  tenantA = a.tenantId;
  customerA = a.customerId;
  conversationA = a.conversationId;

  const b = await seedTenantContext("Aplicar Promocion Test B (sin promos)", "3030000002");
  tenantB = b.tenantId;
  customerB = b.customerId;
  conversationB = b.conversationId;

  const c = await seedTenantContext("Aplicar Promocion Test C (regalo)", "3030000003");
  tenantC = c.tenantId;
  customerC = c.customerId;
  conversationC = c.conversationId;

  const prodA = await adminPool.query<{ id: string }>(
    `INSERT INTO products (tenant_id, sku, name, price) VALUES ($1, 'CASCO-PROMO-A', 'Casco promo A', 100000) RETURNING id`,
    [tenantA],
  );
  productA = prodA.rows[0]!.id;
  await adminPool.query(
    `INSERT INTO inventory (tenant_id, product_id, stock_quantity) VALUES ($1, $2, 100)`,
    [tenantA, productA],
  );

  // Tramos de volumen deliberadamente sin solapar entre sí, para poder
  // aislar cada escenario con la cantidad pedida en la cotización.
  await adminPool.query(
    `INSERT INTO promotions (tenant_id, type, rules, active) VALUES ($1, 'volumen', $2, true)`,
    [
      tenantA,
      JSON.stringify({
        kind: "volumen",
        tiers: [
          { min: 10, max: 19, discount_pct: 5 },
          { min: 30, max: 50, discount_pct: 20 },
        ],
      }),
    ],
  );
  await adminPool.query(
    `INSERT INTO promotions (tenant_id, type, rules, active) VALUES ($1, 'temporada', $2, true)`,
    [tenantA, JSON.stringify({ kind: "temporada", label: "fin_de_año", discount_pct: 15 })],
  );

  const prodB = await adminPool.query<{ id: string }>(
    `INSERT INTO products (tenant_id, sku, name, price) VALUES ($1, 'CASCO-PROMO-B', 'Casco promo B', 100000) RETURNING id`,
    [tenantB],
  );
  productB = prodB.rows[0]!.id;
  await adminPool.query(
    `INSERT INTO inventory (tenant_id, product_id, stock_quantity) VALUES ($1, $2, 100)`,
    [tenantB, productB],
  );

  const prodC = await adminPool.query<{ id: string }>(
    `INSERT INTO products (tenant_id, sku, name, price) VALUES ($1, 'CASCO-PROMO-C', 'Casco promo C', 100000) RETURNING id`,
    [tenantC],
  );
  productC = prodC.rows[0]!.id;
  await adminPool.query(
    `INSERT INTO inventory (tenant_id, product_id, stock_quantity) VALUES ($1, $2, 100)`,
    [tenantC, productC],
  );
  const guantesC = await adminPool.query<{ id: string }>(
    `INSERT INTO products (tenant_id, sku, name, price) VALUES ($1, 'GUANTES-C', 'Guantes regalo', 20000) RETURNING id`,
    [tenantC],
  );
  productGuantesC = guantesC.rows[0]!.id;
  await adminPool.query(
    `INSERT INTO promotions (tenant_id, type, rules, active) VALUES ($1, 'volumen', $2, true)`,
    [
      tenantC,
      JSON.stringify({
        kind: "volumen",
        tiers: [{ min: 1, max: 100, free_item_sku: "GUANTES-C" }],
      }),
    ],
  );
});

afterAll(async () => {
  const tenantIds = [tenantA, tenantB, tenantC];
  await adminPool.query(`DELETE FROM quote_items WHERE tenant_id = ANY($1)`, [tenantIds]);
  await adminPool.query(`DELETE FROM quotes WHERE tenant_id = ANY($1)`, [tenantIds]);
  await adminPool.query(`DELETE FROM promotions WHERE tenant_id = ANY($1)`, [tenantIds]);
  await adminPool.query(`DELETE FROM inventory WHERE tenant_id = ANY($1)`, [tenantIds]);
  await adminPool.query(`DELETE FROM products WHERE tenant_id = ANY($1)`, [tenantIds]);
  await adminPool.query(`DELETE FROM conversations WHERE tenant_id = ANY($1)`, [tenantIds]);
  await adminPool.query(`DELETE FROM customers WHERE tenant_id = ANY($1)`, [tenantIds]);
  await adminPool.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenantIds]);
  await adminPool.end();
  await appPool.end();
});

describe("aplicarPromocion", () => {
  it("aplica la promoción de temporada cuando da mayor beneficio que la de volumen", async () => {
    const quote = await generarCotizacion(tenantA, conversationA, customerA, {
      items: [{ product_id: productA, quantity: 15 }],
    });

    const result = await aplicarPromocion(tenantA, { quote_id: quote.quote_id });

    expect(result.promotion_applied).toMatchObject({ kind: "temporada" });
    expect(result.subtotal).toBe(1500000);
    expect(result.discount).toBe(225000); // 15% de 1.500.000
    expect(result.total).toBe(1275000);
  });

  it("aplica la promoción de volumen cuando da mayor beneficio que la de temporada", async () => {
    const quote = await generarCotizacion(tenantA, conversationA, customerA, {
      items: [{ product_id: productA, quantity: 35 }],
    });

    const result = await aplicarPromocion(tenantA, { quote_id: quote.quote_id });

    expect(result.promotion_applied).toMatchObject({ kind: "volumen" });
    expect(result.discount).toBe(700000); // 20% de 3.500.000
    expect(result.total).toBe(2800000);
  });

  it("no combina promociones: nunca aplica ambas a la vez", async () => {
    const quote = await generarCotizacion(tenantA, conversationA, customerA, {
      items: [{ product_id: productA, quantity: 15 }],
    });

    const result = await aplicarPromocion(tenantA, { quote_id: quote.quote_id });

    // Si se combinaran, el descuento sería 5% + 15% = 300.000, no 225.000.
    expect(result.discount).not.toBe(300000);
    expect(result.discount).toBe(225000);
  });

  it("devuelve promotion_applied null si no hay ninguna promoción activa", async () => {
    const quote = await generarCotizacion(tenantB, conversationB, customerB, {
      items: [{ product_id: productB, quantity: 15 }],
    });

    const result = await aplicarPromocion(tenantB, { quote_id: quote.quote_id });

    expect(result.promotion_applied).toBeNull();
    expect(result.subtotal).toBe(quote.subtotal);
    expect(result.discount).toBe(0);
    expect(result.total).toBe(quote.subtotal);
  });

  it("agrega el producto de regalo a la cotización cuando la promoción es 'producto gratis'", async () => {
    const quote = await generarCotizacion(tenantC, conversationC, customerC, {
      items: [{ product_id: productC, quantity: 3 }],
    });

    const result = await aplicarPromocion(tenantC, { quote_id: quote.quote_id });

    expect(result.promotion_applied).toMatchObject({ kind: "volumen" });
    expect(result.discount).toBe(0);
    expect(result.total).toBe(300000);

    const items = await adminPool.query(
      `SELECT product_id, quantity, unit_price FROM quote_items WHERE quote_id = $1 AND product_id = $2`,
      [quote.quote_id, productGuantesC],
    );
    expect(items.rows).toHaveLength(1);
    expect(items.rows[0]).toMatchObject({ quantity: 1, unit_price: "0.00" });
  });

  it("falla si la cotización no existe", async () => {
    await expect(
      aplicarPromocion(tenantA, { quote_id: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(/Cotización no encontrada/);
  });
});
