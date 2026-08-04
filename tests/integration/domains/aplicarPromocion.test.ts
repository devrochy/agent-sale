import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aplicarPromocion } from "../../../src/domains/commerce/aplicarPromocion.js";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { deleteProduct, seedProduct } from "../../helpers/seedCatalog.js";

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
let variantA: string;
let productB: string;
let variantB: string;
let productC: string;
let variantC: string;
let productGuantesC: string;
let variantGuantesC: string;

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

  const prodA = await seedProduct(adminPool, { sku: "CASCO-PROMO-A", name: "Casco promo A", price: 100000, stock: 100 });
  productA = prodA.productId;
  variantA = prodA.variantId;

  const prodB = await seedProduct(adminPool, { sku: "CASCO-PROMO-B", name: "Casco promo B", price: 100000, stock: 100 });
  productB = prodB.productId;
  variantB = prodB.variantId;

  const prodC = await seedProduct(adminPool, { sku: "CASCO-PROMO-C", name: "Casco promo C", price: 100000, stock: 100 });
  productC = prodC.productId;
  variantC = prodC.variantId;

  const guantesC = await seedProduct(adminPool, { sku: "GUANTES-C", name: "Guantes regalo", price: 20000, stock: 100 });
  productGuantesC = guantesC.productId;
  variantGuantesC = guantesC.variantId;
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
  for (const productId of productIds) {
    await deleteProduct(adminPool, productId);
  }
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
        items: [{ variant_id: variantA, quantity: 15 }],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

      expect(result.promotion_applied).toMatchObject({ kind: "temporada" });
      expect(result.subtotal).toBe(1500000);
      expect(result.discount).toBe(225000); // 15% de 1.500.000
      expect(result.total).toBe(1275000);
    });

    it("aplica la promoción de volumen cuando da mayor beneficio que la de temporada", async () => {
      const quote = await generarCotizacion(conversationA, customerA, {
        items: [{ variant_id: variantA, quantity: 35 }],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

      expect(result.promotion_applied).toMatchObject({ kind: "volumen" });
      expect(result.discount).toBe(700000); // 20% de 3.500.000
      expect(result.total).toBe(2800000);
    });

    it("no combina promociones: nunca aplica ambas a la vez", async () => {
      const quote = await generarCotizacion(conversationA, customerA, {
        items: [{ variant_id: variantA, quantity: 15 }],
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
        items: [{ variant_id: variantB, quantity: 15 }],
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
        items: [{ variant_id: variantC, quantity: 3 }],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

      expect(result.promotion_applied).toMatchObject({ kind: "volumen" });
      expect(result.discount).toBe(0);
      expect(result.total).toBe(300000);

      const items = await adminPool.query(
        `SELECT variant_id, quantity, unit_price FROM quote_items WHERE quote_id = $1 AND variant_id = $2`,
        [quote.quote_id, variantGuantesC],
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
