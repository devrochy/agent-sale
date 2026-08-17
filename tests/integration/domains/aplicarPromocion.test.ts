import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aplicarPromocion, clasificarCliente } from "../../../src/domains/commerce/aplicarPromocion.js";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { withTransaction } from "../../../src/shared/db/withTransaction.js";
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
// settings es singleton (ver ADR-032) — se siembra acá para que
// clasificarCliente (Fase 17) pueda leer los umbrales de segmento, mismo
// patrón que crearPedido.test.ts.
let settingsId: string;

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

  const settings = await adminPool.query<{ id: string }>(
    `INSERT INTO settings (name) VALUES ('Aplicar Promocion Test') RETURNING id`,
  );
  settingsId = settings.rows[0]!.id;
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
  await adminPool.query(`DELETE FROM settings WHERE id = $1`, [settingsId]);
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
      await adminPool.query(`UPDATE quotes SET applied_promotion_id = NULL WHERE applied_promotion_id = ANY($1)`, [
        promotionIds,
      ]);
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
      await adminPool.query(`UPDATE quotes SET applied_promotion_id = NULL WHERE applied_promotion_id = $1`, [
        promotionId,
      ]);
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

  describe("con promoción exclusiva de un aliado (Fase 17)", () => {
    let customerD: string;
    let conversationD: string;
    let allyX: string;
    let allyY: string;
    let productX: string;
    let variantX: string;
    let productY: string;
    let variantY: string;
    let promotionId: string;

    beforeAll(async () => {
      const ctx = await seedContext("3030000004");
      customerD = ctx.customerId;
      conversationD = ctx.conversationId;

      const aX = await adminPool.query<{ id: string }>(
        `INSERT INTO allies (name) VALUES ('Aliado Aislamiento X') RETURNING id`,
      );
      allyX = aX.rows[0]!.id;
      const aY = await adminPool.query<{ id: string }>(
        `INSERT INTO allies (name) VALUES ('Aliado Aislamiento Y') RETURNING id`,
      );
      allyY = aY.rows[0]!.id;

      const prodX = await adminPool.query<{ id: string }>(
        `INSERT INTO products (ally_id, name) VALUES ($1, 'Producto aliado X') RETURNING id`,
        [allyX],
      );
      productX = prodX.rows[0]!.id;
      const varX = await adminPool.query<{ id: string }>(
        `INSERT INTO product_variants (product_id, sku, price) VALUES ($1, 'ALIADO-X-1', 100000) RETURNING id`,
        [productX],
      );
      variantX = varX.rows[0]!.id;
      await adminPool.query(`INSERT INTO inventory (variant_id, stock_quantity) VALUES ($1, 100)`, [variantX]);

      const prodY = await adminPool.query<{ id: string }>(
        `INSERT INTO products (ally_id, name) VALUES ($1, 'Producto aliado Y') RETURNING id`,
        [allyY],
      );
      productY = prodY.rows[0]!.id;
      const varY = await adminPool.query<{ id: string }>(
        `INSERT INTO product_variants (product_id, sku, price) VALUES ($1, 'ALIADO-Y-1', 50000) RETURNING id`,
        [productY],
      );
      variantY = varY.rows[0]!.id;
      await adminPool.query(`INSERT INTO inventory (variant_id, stock_quantity) VALUES ($1, 100)`, [variantY]);

      const promo = await adminPool.query<{ id: string }>(
        `INSERT INTO promotions (type, rules, active, ally_id) VALUES ('temporada', $1, true, $2) RETURNING id`,
        [JSON.stringify({ kind: "temporada", label: "aliado_x", discount_pct: 10 }), allyX],
      );
      promotionId = promo.rows[0]!.id;
    });

    afterAll(async () => {
      await adminPool.query(`UPDATE quotes SET applied_promotion_id = NULL WHERE applied_promotion_id = $1`, [
        promotionId,
      ]);
      await adminPool.query(`DELETE FROM promotions WHERE id = $1`, [promotionId]);
      await adminPool.query(
        `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`,
        [conversationD],
      );
      await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationD]);
      await deleteProduct(adminPool, productX);
      await deleteProduct(adminPool, productY);
      await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationD]);
      await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerD]);
      await adminPool.query(`DELETE FROM allies WHERE id = ANY($1)`, [[allyX, allyY]]);
    });

    it("aplica cuando todos los items son del aliado exclusivo", async () => {
      const quote = await generarCotizacion(conversationD, customerD, {
        items: [{ variant_id: variantX, quantity: 1 }],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

      expect(result.promotion_applied).toMatchObject({ id: promotionId, kind: "temporada" });
    });

    it("NO aplica si la cotización mezcla un producto de otro aliado (aislamiento)", async () => {
      const quote = await generarCotizacion(conversationD, customerD, {
        items: [
          { variant_id: variantX, quantity: 1 },
          { variant_id: variantY, quantity: 1 },
        ],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

      expect(result.promotion_applied).toBeNull();
    });
  });

  describe("con promoción de categoría que incluye subcategorías (Fase 17)", () => {
    let customerE: string;
    let conversationE: string;
    let categoryParent: string;
    let categoryChild: string;
    let productE: string;
    let variantE: string;
    let promotionId: string;

    beforeAll(async () => {
      const ctx = await seedContext("3030000005");
      customerE = ctx.customerId;
      conversationE = ctx.conversationId;

      // No depender de un catálogo pre-sembrado (scripts/seed-catalogo-prueba.ts
      // solo se corre a mano para pruebas manuales, CI nunca lo ejecuta) —
      // mismo criterio que el resto de describes de este archivo, cada
      // escenario siembra y borra sus propios datos.
      const parent = await adminPool.query<{ id: string }>(
        `INSERT INTO product_categories (name) VALUES ('Protección personal test Fase17') RETURNING id`,
      );
      categoryParent = parent.rows[0]!.id;
      const child = await adminPool.query<{ id: string }>(
        `INSERT INTO product_categories (name, parent_id) VALUES ('Guantes test Fase17', $1) RETURNING id`,
        [categoryParent],
      );
      categoryChild = child.rows[0]!.id;

      const prod = await seedProduct(adminPool, {
        sku: "GUANTES-CATEGORIA-E",
        name: "Guantes de prueba",
        price: 80000,
        stock: 50,
        categoryId: categoryChild,
      });
      productE = prod.productId;
      variantE = prod.variantId;

      const promo = await adminPool.query<{ id: string }>(
        `INSERT INTO promotions (type, rules, active, category_id) VALUES ('temporada', $1, true, $2) RETURNING id`,
        [JSON.stringify({ kind: "temporada", label: "proteccion_personal", discount_pct: 12 }), categoryParent],
      );
      promotionId = promo.rows[0]!.id;
    });

    afterAll(async () => {
      await adminPool.query(`UPDATE quotes SET applied_promotion_id = NULL WHERE applied_promotion_id = $1`, [
        promotionId,
      ]);
      await adminPool.query(`DELETE FROM promotions WHERE id = $1`, [promotionId]);
      await adminPool.query(
        `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`,
        [conversationE],
      );
      await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationE]);
      await deleteProduct(adminPool, productE);
      await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationE]);
      await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerE]);
      await adminPool.query(`DELETE FROM product_categories WHERE id = $1`, [categoryChild]);
      await adminPool.query(`DELETE FROM product_categories WHERE id = $1`, [categoryParent]);
    });

    it("aplica una promoción de la categoría padre a un producto de su subcategoría", async () => {
      const quote = await generarCotizacion(conversationE, customerE, {
        items: [{ variant_id: variantE, quantity: 1 }],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

      expect(result.promotion_applied).toMatchObject({ id: promotionId, kind: "temporada" });
    });
  });

  describe("con promoción de un producto puntual (Fase 17)", () => {
    let customerF: string;
    let conversationF: string;
    let productF1: string;
    let variantF1: string;
    let productF2: string;
    let variantF2: string;
    let promotionId: string;

    beforeAll(async () => {
      const ctx = await seedContext("3030000006");
      customerF = ctx.customerId;
      conversationF = ctx.conversationId;

      const p1 = await seedProduct(adminPool, { sku: "PRODUCTO-PUNTUAL-F1", name: "Producto puntual F1", price: 60000, stock: 50 });
      productF1 = p1.productId;
      variantF1 = p1.variantId;

      const p2 = await seedProduct(adminPool, { sku: "PRODUCTO-OTRO-F2", name: "Producto otro F2", price: 40000, stock: 50 });
      productF2 = p2.productId;
      variantF2 = p2.variantId;

      const promo = await adminPool.query<{ id: string }>(
        `INSERT INTO promotions (type, rules, active, product_id) VALUES ('temporada', $1, true, $2) RETURNING id`,
        [JSON.stringify({ kind: "temporada", label: "producto_f1", discount_pct: 8 }), productF1],
      );
      promotionId = promo.rows[0]!.id;
    });

    afterAll(async () => {
      await adminPool.query(`UPDATE quotes SET applied_promotion_id = NULL WHERE applied_promotion_id = $1`, [
        promotionId,
      ]);
      await adminPool.query(`DELETE FROM promotions WHERE id = $1`, [promotionId]);
      await adminPool.query(
        `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`,
        [conversationF],
      );
      await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationF]);
      await deleteProduct(adminPool, productF1);
      await deleteProduct(adminPool, productF2);
      await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationF]);
      await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerF]);
    });

    it("aplica solo si la cotización es exclusivamente del producto puntual", async () => {
      const quote = await generarCotizacion(conversationF, customerF, {
        items: [{ variant_id: variantF1, quantity: 1 }],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

      expect(result.promotion_applied).toMatchObject({ id: promotionId, kind: "temporada" });
    });

    it("NO aplica si la cotización incluye otro producto", async () => {
      const quote = await generarCotizacion(conversationF, customerF, {
        items: [
          { variant_id: variantF1, quantity: 1 },
          { variant_id: variantF2, quantity: 1 },
        ],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

      expect(result.promotion_applied).toBeNull();
    });
  });

  describe("con promoción restringida a un segmento de cliente (Fase 17)", () => {
    let customerG: string;
    let conversationG: string;
    let productG: string;
    let variantG: string;
    let promotionId: string;

    beforeAll(async () => {
      const ctx = await seedContext("3030000007");
      customerG = ctx.customerId;
      conversationG = ctx.conversationId;

      const prod = await seedProduct(adminPool, { sku: "PRODUCTO-SEGMENTO-G", name: "Producto segmento G", price: 90000, stock: 50 });
      productG = prod.productId;
      variantG = prod.variantId;

      const promo = await adminPool.query<{ id: string }>(
        `INSERT INTO promotions (type, rules, active, eligible_segments) VALUES ('temporada', $1, true, $2) RETURNING id`,
        [
          JSON.stringify({ kind: "temporada", label: "solo_frecuentes", discount_pct: 20 }),
          ["frecuente", "fiel"],
        ],
      );
      promotionId = promo.rows[0]!.id;
    });

    afterAll(async () => {
      await adminPool.query(`UPDATE quotes SET applied_promotion_id = NULL WHERE applied_promotion_id = $1`, [
        promotionId,
      ]);
      await adminPool.query(`DELETE FROM promotions WHERE id = $1`, [promotionId]);
      await adminPool.query(
        `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`,
        [conversationG],
      );
      await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationG]);
      await deleteProduct(adminPool, productG);
      await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationG]);
      await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerG]);
    });

    it("NO aplica a un cliente 'nuevo' sin pedidos previos", async () => {
      const quote = await generarCotizacion(conversationG, customerG, {
        items: [{ variant_id: variantG, quantity: 1 }],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

      expect(result.promotion_applied).toBeNull();
    });
  });

  describe("con campaña once_per_customer (Fase 17)", () => {
    let customerH: string;
    let conversationH: string;
    let productH: string;
    let variantH: string;
    let promotionId: string;
    let redeemingOrderId: string;

    beforeAll(async () => {
      const ctx = await seedContext("3030000008");
      customerH = ctx.customerId;
      conversationH = ctx.conversationId;

      const prod = await seedProduct(adminPool, { sku: "PRODUCTO-CAMPANA-H", name: "Producto campaña H", price: 70000, stock: 50 });
      productH = prod.productId;
      variantH = prod.variantId;

      const promo = await adminPool.query<{ id: string }>(
        `INSERT INTO promotions (type, rules, active) VALUES ('campaña', $1, true) RETURNING id`,
        [JSON.stringify({ kind: "campaña", label: "bienvenida", discount_pct: 15, once_per_customer: true })],
      );
      promotionId = promo.rows[0]!.id;
    });

    afterAll(async () => {
      await adminPool.query(`DELETE FROM promotion_redemptions WHERE promotion_id = $1`, [promotionId]);
      await adminPool.query(`DELETE FROM orders WHERE id = $1`, [redeemingOrderId]);
      await adminPool.query(`UPDATE quotes SET applied_promotion_id = NULL WHERE applied_promotion_id = $1`, [
        promotionId,
      ]);
      await adminPool.query(`DELETE FROM promotions WHERE id = $1`, [promotionId]);
      await adminPool.query(
        `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`,
        [conversationH],
      );
      await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationH]);
      await deleteProduct(adminPool, productH);
      await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationH]);
      await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerH]);
    });

    it("aplica la campaña la primera vez", async () => {
      const quote = await generarCotizacion(conversationH, customerH, {
        items: [{ variant_id: variantH, quantity: 1 }],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

      expect(result.promotion_applied).toMatchObject({ id: promotionId, kind: "campaña" });

      const order = await adminPool.query<{ id: string }>(
        `INSERT INTO orders (quote_id, conversation_id, customer_id, status, payment_method, payment_status, delivery_method, idempotency_key, total)
         VALUES ($1, $2, $3, 'abierto', 'efectivo_contraentrega', 'pagado', 'recoger_en_tienda', $4, $5)
         RETURNING id`,
        [quote.quote_id, conversationH, customerH, `test-redencion-${quote.quote_id}`, result.total],
      );
      redeemingOrderId = order.rows[0]!.id;
      await adminPool.query(
        `INSERT INTO promotion_redemptions (promotion_id, customer_id, order_id) VALUES ($1, $2, $3)`,
        [promotionId, customerH, redeemingOrderId],
      );
    });

    it("NO se reaplica tras una redención ya registrada", async () => {
      const quote = await generarCotizacion(conversationH, customerH, {
        items: [{ variant_id: variantH, quantity: 1 }],
      });

      const result = await aplicarPromocion({ quote_id: quote.quote_id });

      expect(result.promotion_applied).toBeNull();
    });
  });

  it("falla si la cotización no existe", async () => {
    await expect(
      aplicarPromocion({ quote_id: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(/Cotización no encontrada/);
  });

  describe("clasificarCliente en 5 niveles (Fase 23, ADR-036)", () => {
    // Umbrales por defecto del singleton `settings` sembrado en el
    // beforeAll de arriba: customer_frecuente_min_pedidos=2,
    // customer_frecuente_intervalo_max_dias=45,
    // customer_inactivo_dias_sin_comprar=120, customer_fiel_min_pedidos=5.
    const conversationIds: string[] = [];
    const customerIds: string[] = [];
    const quoteIds: string[] = [];

    async function seedCliente(phone: string): Promise<{ customerId: string; conversationId: string; quoteId: string }> {
      const ctx = await seedContext(phone);
      const quote = await adminPool.query<{ id: string }>(
        `INSERT INTO quotes (conversation_id, customer_id, subtotal, total) VALUES ($1, $2, 50000, 50000) RETURNING id`,
        [ctx.conversationId, ctx.customerId],
      );
      conversationIds.push(ctx.conversationId);
      customerIds.push(ctx.customerId);
      quoteIds.push(quote.rows[0]!.id);
      return { customerId: ctx.customerId, conversationId: ctx.conversationId, quoteId: quote.rows[0]!.id };
    }

    async function seedPedido(quoteId: string, conversationId: string, customerId: string, ageDays: number): Promise<void> {
      await adminPool.query(
        `INSERT INTO orders
           (quote_id, conversation_id, customer_id, status, payment_method, payment_status, delivery_method, idempotency_key, total, created_at)
         VALUES ($1, $2, $3, 'abierto', 'efectivo_contraentrega', 'pagado', 'recoger_en_tienda', $4, 50000, now() - ($5 || ' days')::interval)`,
        [quoteId, conversationId, customerId, `test-clasificacion-${quoteId}-${ageDays}`, ageDays],
      );
    }

    async function clasificar(customerId: string): Promise<string> {
      return withTransaction((client) => clasificarCliente(client, customerId));
    }

    afterAll(async () => {
      await adminPool.query(`DELETE FROM orders WHERE quote_id = ANY($1)`, [quoteIds]);
      await adminPool.query(`DELETE FROM quotes WHERE id = ANY($1)`, [quoteIds]);
      await adminPool.query(`DELETE FROM conversations WHERE id = ANY($1)`, [conversationIds]);
      await adminPool.query(`DELETE FROM customers WHERE id = ANY($1)`, [customerIds]);
    });

    it("sin pedidos → nuevo", async () => {
      const { customerId } = await seedCliente("3030000009");

      await expect(clasificar(customerId)).resolves.toBe("nuevo");
    });

    it("con un solo pedido → nuevo (deja de serlo en el segundo)", async () => {
      const { customerId, quoteId, conversationId } = await seedCliente("3030000010");
      await seedPedido(quoteId, conversationId, customerId, 0);

      await expect(clasificar(customerId)).resolves.toBe("nuevo");
    });

    it("2+ pedidos con intervalo corto (≤45 días) → frecuente", async () => {
      const { customerId, quoteId, conversationId } = await seedCliente("3030000011");
      await seedPedido(quoteId, conversationId, customerId, 20);
      await seedPedido(quoteId, conversationId, customerId, 10);
      await seedPedido(quoteId, conversationId, customerId, 0);

      await expect(clasificar(customerId)).resolves.toBe("frecuente");
    });

    it("2+ pedidos con intervalo largo (>45 días) → ocasional", async () => {
      const { customerId, quoteId, conversationId } = await seedCliente("3030000012");
      await seedPedido(quoteId, conversationId, customerId, 100);
      await seedPedido(quoteId, conversationId, customerId, 50);
      await seedPedido(quoteId, conversationId, customerId, 0);

      await expect(clasificar(customerId)).resolves.toBe("ocasional");
    });

    it("5+ pedidos (umbral fiel) → fiel sin importar el intervalo", async () => {
      const { customerId, quoteId, conversationId } = await seedCliente("3030000013");
      await seedPedido(quoteId, conversationId, customerId, 40);
      await seedPedido(quoteId, conversationId, customerId, 30);
      await seedPedido(quoteId, conversationId, customerId, 20);
      await seedPedido(quoteId, conversationId, customerId, 10);
      await seedPedido(quoteId, conversationId, customerId, 0);

      await expect(clasificar(customerId)).resolves.toBe("fiel");
    });

    it("último pedido hace más de 120 días → inactivo, sobrescribe cualquier otra clasificación", async () => {
      const { customerId, quoteId, conversationId } = await seedCliente("3030000014");
      await seedPedido(quoteId, conversationId, customerId, 200);
      await seedPedido(quoteId, conversationId, customerId, 130);

      await expect(clasificar(customerId)).resolves.toBe("inactivo");
    });
  });
});
