import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aplicarPromocion } from "../../../src/domains/commerce/aplicarPromocion.js";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

// promotions ya no está scoped por tenant — es una tabla global del único
// negocio. Antes cada escenario (A: volumen+temporada, B: sin promos, C:
// producto gratis) vivía bajo su propio tenant, así que las tres tandas de
// promociones podían coexistir sin pisarse. Ahora coexistir las rompería
// (ej. la promoción de temporada de A ganaría por beneficio a la de
// "producto gratis" de C si ambas estuvieran activas a la vez) — cada
// escenario siembra y borra sus propias promociones en su propio
// describe, para que solo una tanda esté activa mientras corren sus tests.
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

async function seedContext(phone: string) {
  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (phone_number) VALUES ($1) RETURNING id`,
    [phone],
  );
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customer.rows[0]!.id],
  );
  return { customerId: customer.rows[0]!.id, conversationId: conversation.rows[0]!.id };
}

beforeAll(async () => {
  const a = await seedContext("3030000001");
  customerA = a.customerId;
  conversationA = a.conversationId;

  const b = await seedContext("3030000002");
  customerB = b.customerId;
  conversationB = b.conversationId;

  const c = await seedContext("3030000003");
  customerC = c.customerId;
  conversationC = c.conversationId;

  const prodA = await adminPool.query<{ id: string }>(
    `INSERT INTO products (sku, name, price) VALUES ('CASCO-PROMO-A', 'Casco promo A', 100000) RETURNING id`,
  );
  productA = prodA.rows[0]!.id;
  await adminPool.query(`INSERT INTO inventory (product_id, stock_quantity) VALUES ($1, 100)`, [
    productA,
  ]);

  const prodB = await adminPool.query<{ id: string }>(
    `INSERT INTO products (sku, name, price) VALUES ('CASCO-PROMO-B', 'Casco promo B', 100000) RETURNING id`,
  );
  productB = prodB.rows[0]!.id;
  await adminPool.query(`INSERT INTO inventory (product_id, stock_quantity) VALUES ($1, 100)`, [
    productB,
  ]);

  const prodC = await adminPool.query<{ id: string }>(
    `INSERT INTO products (sku, name, price) VALUES ('CASCO-PROMO-C', 'Casco promo C', 100000) RETURNING id`,
  );
  productC = prodC.rows[0]!.id;
  await adminPool.query(`INSERT INTO inventory (product_id, stock_quantity) VALUES ($1, 100)`, [
    productC,
  ]);
  const guantesC = await adminPool.query<{ id: string }>(
    `INSERT INTO products (sku, name, price) VALUES ('GUANTES-C', 'Guantes regalo', 20000) RETURNING id`,
  );
  productGuantesC = guantesC.rows[0]!.id;
});

afterAll(async () => {
  const conversationIds = [conversationA, conversationB, conversationC];
  const customerIds = [customerA, customerB, customerC];
  const productIds = [productA, productB, productC, productGuantesC];
  await adminPool.query(
    `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = ANY($1))`,
    [conversationIds],
  );
  await adminPool.query(`DELETE FROM quotes WHERE conversation_id = ANY($1)`, [conversationIds]);
  await adminPool.query(`DELETE FROM inventory WHERE product_id = ANY($1)`, [productIds]);
  await adminPool.query(`DELETE FROM products WHERE id = ANY($1)`, [productIds]);
  await adminPool.query(`DELETE FROM conversations WHERE id = ANY($1)`, [conversationIds]);
  await adminPool.query(`DELETE FROM customers WHERE id = ANY($1)`, [customerIds]);
  await adminPool.end();
  await appPool.end();
});

describe("aplicarPromocion", () => {
  describe("con promoción de volumen y de temporada activas (gana la de mayor beneficio)", () => {
    const promotionIds: string[] = [];

    beforeAll(async () => {
      // Tramos de volumen deliberadamente sin solapar entre sí, para poder
      // aislar cada escenario con la cantidad pedida en la cotización.
      const volumen = await adminPool.query<{ id: string }>(
        `INSERT INTO promotions (type, rules, active) VALUES ('volumen', $1, true) RETURNING id`,
        [
          JSON.stringify({
            kind: "volumen",
            tiers: [
              { min: 10, max: 19, discount_pct: 5 },
              { min: 30, max: 50, discount_pct: 20 },
            ],
          }),
        ],
      );
      promotionIds.push(volumen.rows[0]!.id);
      const temporada = await adminPool.query<{ id: string }>(
        `INSERT INTO promotions (type, rules, active) VALUES ('temporada', $1, true) RETURNING id`,
        [JSON.stringify({ kind: "temporada", label: "fin_de_año", discount_pct: 15 })],
      );
      promotionIds.push(temporada.rows[0]!.id);
    });

    afterAll(async () => {
      await adminPool.query(`DELETE FROM promotions WHERE id = ANY($1)`, [promotionIds]);
    });

    it("aplica la promoción de temporada cuando da mayor beneficio que la de volumen", async () => {
      const quote = await generarCotizacion(conversationA, customerA, {
        items: [{ product_id: productA, quantity: 15 }],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

      expect(result.promotion_applied).toMatchObject({ kind: "temporada" });
      expect(result.subtotal).toBe(1500000);
      expect(result.discount).toBe(225000); // 15% de 1.500.000
      expect(result.total).toBe(1275000);
    });

    it("aplica la promoción de volumen cuando da mayor beneficio que la de temporada", async () => {
      const quote = await generarCotizacion(conversationA, customerA, {
        items: [{ product_id: productA, quantity: 35 }],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

      expect(result.promotion_applied).toMatchObject({ kind: "volumen" });
      expect(result.discount).toBe(700000); // 20% de 3.500.000
      expect(result.total).toBe(2800000);
    });

    it("no combina promociones: nunca aplica ambas a la vez", async () => {
      const quote = await generarCotizacion(conversationA, customerA, {
        items: [{ product_id: productA, quantity: 15 }],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

      // Si se combinaran, el descuento sería 5% + 15% = 300.000, no 225.000.
      expect(result.discount).not.toBe(300000);
      expect(result.discount).toBe(225000);
    });
  });

  describe("sin ninguna promoción activa", () => {
    it("devuelve promotion_applied null", async () => {
      const quote = await generarCotizacion(conversationB, customerB, {
        items: [{ product_id: productB, quantity: 15 }],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

      expect(result.promotion_applied).toBeNull();
      expect(result.subtotal).toBe(quote.subtotal);
      expect(result.discount).toBe(0);
      expect(result.total).toBe(quote.subtotal);
    });
  });

  describe("con promoción de producto gratis activa", () => {
    let promotionId: string;

    beforeAll(async () => {
      const volumen = await adminPool.query<{ id: string }>(
        `INSERT INTO promotions (type, rules, active) VALUES ('volumen', $1, true) RETURNING id`,
        [JSON.stringify({ kind: "volumen", tiers: [{ min: 1, max: 100, free_item_sku: "GUANTES-C" }] })],
      );
      promotionId = volumen.rows[0]!.id;
    });

    afterAll(async () => {
      await adminPool.query(`DELETE FROM promotions WHERE id = $1`, [promotionId]);
    });

    it("agrega el producto de regalo a la cotización cuando la promoción es 'producto gratis'", async () => {
      const quote = await generarCotizacion(conversationC, customerC, {
        items: [{ product_id: productC, quantity: 3 }],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

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
  });

  it("falla si la cotización no existe", async () => {
    await expect(
      aplicarPromocion({ quote_id: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(/Cotización no encontrada/);
  });
});
