import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aplicarPromocion } from "../../../src/domains/commerce/aplicarPromocion.js";
import { crearPedido } from "../../../src/domains/commerce/crearPedido.js";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { saveWompiConfig } from "../../../src/shared/db/settingsDirectory.js";
import { deleteProduct, seedProduct } from "../../helpers/seedCatalog.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

// customer_data mínimo para llegar a status "confirmed" — ver ADR-033.
// save_permanently: false por defecto para no ensuciar `customers` en los
// tests que no lo ejercitan explícitamente.
const customerData = {
  address: "Calle 1 # 2-34",
  id_document: "123456789",
  full_name: "Cliente De Prueba",
  save_permanently: false,
};

let conversationA: string;
let customerA: string;
let productA: string;
let variantA: string;
// Cliente aparte para el describe "datos de cliente" — necesita empezar
// sin address/id_document/full_name guardados, algo que customerA ya no
// garantiza una vez que otros tests de este archivo corren.
let conversationB: string;
let customerB: string;
// La sección "pago_en_linea" necesita una fila de settings para
// getWompiConfig/saveWompiConfig (settings es singleton — se siembra acá,
// no en el beforeAll general, porque el resto de los tests de este
// archivo no la necesitan).
let settingsId: string;

beforeAll(async () => {
  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id, contact_phone) VALUES ('whatsapp:+3040000001', '+3040000001') RETURNING id`,
  );
  customerA = customer.rows[0]!.id;
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerA],
  );
  conversationA = conversation.rows[0]!.id;

  const customerBRow = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id, contact_phone) VALUES ('whatsapp:+3040000002', '+3040000002') RETURNING id`,
  );
  customerB = customerBRow.rows[0]!.id;
  const conversationBRow = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerB],
  );
  conversationB = conversationBRow.rows[0]!.id;

  const product = await seedProduct(adminPool, {
    sku: "CASCO-PEDIDO",
    name: "Casco pedido",
    price: 100000,
    stock: 50,
  });
  productA = product.productId;
  variantA = product.variantId;

  const settings = await adminPool.query<{ id: string }>(
    `INSERT INTO settings (name) VALUES ('Crear Pedido Test') RETURNING id`,
  );
  settingsId = settings.rows[0]!.id;
});

afterAll(async () => {
  for (const conversationId of [conversationA, conversationB]) {
    await adminPool.query(
      `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = $1)`,
      [conversationId],
    );
    await adminPool.query(
      `DELETE FROM wompi_payment_links WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = $1)`,
      [conversationId],
    );
    await adminPool.query(`DELETE FROM orders WHERE conversation_id = $1`, [conversationId]);
    await adminPool.query(
      `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`,
      [conversationId],
    );
    await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationId]);
    await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
  }
  await deleteProduct(adminPool, productA);
  await adminPool.query(`DELETE FROM customers WHERE id IN ($1, $2)`, [customerA, customerB]);
  await adminPool.query(`DELETE FROM settings WHERE id = $1`, [settingsId]);
  await adminPool.end();
  await appPool.end();
});

describe("crearPedido", () => {
  it("crea un pedido confirmado a partir de una cotización, copiando los items", async () => {
    const quote = await generarCotizacion(conversationA, customerA, {
      items: [{ variant_id: variantA, quantity: 2 }],
    });

    const result = await crearPedido(
      "sid-1",
      {
        quote_id: quote.quote_id,
        payment_method: "transferencia",
        delivery_method: "domicilio",
        customer_data: customerData,
      },
      1000000,
    );

    expect(result.status).toBe("confirmed");
    expect(result.total).toBe(200000);

    const items = await adminPool.query(
      `SELECT variant_id, quantity, unit_price FROM order_items WHERE order_id = $1`,
      [result.order_id],
    );
    expect(items.rows).toHaveLength(1);
    expect(items.rows[0]).toMatchObject({ variant_id: variantA, quantity: 2 });

    const stock = await adminPool.query<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM inventory WHERE variant_id = $1`,
      [variantA],
    );
    expect(stock.rows[0]!.stock_quantity).toBe(48); // 50 - 2
  });

  it("el mismo message_sid reintentado sobre la misma cotización devuelve el mismo pedido (status duplicate)", async () => {
    const quote = await generarCotizacion(conversationA, customerA, {
      items: [{ variant_id: variantA, quantity: 1 }],
    });

    const first = await crearPedido(
      "sid-2",
      {
        quote_id: quote.quote_id,
        payment_method: "tarjeta",
        delivery_method: "recoger_en_tienda",
        customer_data: customerData,
      },
      1000000,
    );
    const second = await crearPedido(
      "sid-2",
      {
        quote_id: quote.quote_id,
        payment_method: "tarjeta",
        delivery_method: "recoger_en_tienda",
        customer_data: customerData,
      },
      1000000,
    );

    expect(second.status).toBe("duplicate");
    expect(second.order_id).toBe(first.order_id);

    const count = await adminPool.query(`SELECT COUNT(*) FROM orders WHERE quote_id = $1`, [
      quote.quote_id,
    ]);
    expect(Number(count.rows[0].count)).toBe(1);

    // El reintento "duplicate" no debe descontar stock una segunda vez
    // para la misma cotización — solo la creación real del pedido resta.
    const stock = await adminPool.query<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM inventory WHERE variant_id = $1`,
      [variantA],
    );
    expect(stock.rows[0]!.stock_quantity).toBe(47); // 48 - 1 (de este test), no -2
  });

  it("un message_sid distinto sobre una cotización ya convertida en pedido también devuelve 'duplicate' (0..1 quote->order)", async () => {
    const quote = await generarCotizacion(conversationA, customerA, {
      items: [{ variant_id: variantA, quantity: 1 }],
    });

    const first = await crearPedido(
      "sid-3",
      {
        quote_id: quote.quote_id,
        payment_method: "efectivo_contraentrega",
        delivery_method: "domicilio",
        customer_data: customerData,
      },
      1000000,
    );
    const second = await crearPedido(
      "sid-distinto",
      {
        quote_id: quote.quote_id,
        payment_method: "efectivo_contraentrega",
        delivery_method: "domicilio",
        customer_data: customerData,
      },
      1000000,
    );

    expect(second.status).toBe("duplicate");
    expect(second.order_id).toBe(first.order_id);

    const count = await adminPool.query(`SELECT COUNT(*) FROM orders WHERE quote_id = $1`, [
      quote.quote_id,
    ]);
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it("falla si la cotización no existe", async () => {
    await expect(
      crearPedido(
        "sid-4",
        {
          quote_id: "00000000-0000-0000-0000-000000000000",
          payment_method: "transferencia",
          delivery_method: "domicilio",
        },
        1000000,
      ),
    ).rejects.toThrow(/Cotización no encontrada/);
  });

  it("se niega a confirmar un pedido de monto alto: no crea la orden ni descuenta stock", async () => {
    const quote = await generarCotizacion(conversationA, customerA, {
      items: [{ variant_id: variantA, quantity: 5 }], // 5 x 100.000 = 500.000
    });

    const stockBefore = await adminPool.query<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM inventory WHERE variant_id = $1`,
      [variantA],
    );

    const result = await crearPedido(
      "sid-5",
      {
        quote_id: quote.quote_id,
        payment_method: "transferencia",
        delivery_method: "domicilio",
      },
      300000, // umbral menor que el subtotal de la cotización (500.000)
    );

    expect(result).toEqual({ order_id: null, status: "monto_alto", total: 500000 });

    const count = await adminPool.query(`SELECT COUNT(*) FROM orders WHERE quote_id = $1`, [
      quote.quote_id,
    ]);
    expect(Number(count.rows[0].count)).toBe(0);

    const stockAfter = await adminPool.query<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM inventory WHERE variant_id = $1`,
      [variantA],
    );
    expect(stockAfter.rows[0]!.stock_quantity).toBe(stockBefore.rows[0]!.stock_quantity);
  });

  describe("pago_en_linea (Fase 12.4, Wompi)", () => {
    it("sin Wompi configurado, devuelve 'wompi_no_configurado' sin crear pedido", async () => {
      const quote = await generarCotizacion(conversationA, customerA, {
        items: [{ variant_id: variantA, quantity: 1 }],
      });

      const result = await crearPedido(
        "sid-wompi-no-config",
        {
          quote_id: quote.quote_id,
          payment_method: "pago_en_linea",
          delivery_method: "domicilio",
          customer_data: customerData,
        },
        1000000,
      );

      expect(result).toEqual({ order_id: null, status: "wompi_no_configurado", total: 100000 });

      const count = await adminPool.query(`SELECT COUNT(*) FROM orders WHERE quote_id = $1`, [
        quote.quote_id,
      ]);
      expect(Number(count.rows[0].count)).toBe(0);
    });

    it("con Wompi configurado pero total por debajo del mínimo, devuelve 'wompi_monto_minimo' sin llamar a Wompi", async () => {
      await saveWompiConfig({ privateKey: "prv_test_fake", eventsSecret: "test_events_fake" });
      vi.stubGlobal("fetch", vi.fn());

      const quote = await generarCotizacion(conversationA, customerA, {
        items: [{ variant_id: variantA, quantity: 1 }], // 1 x 100.000 = 100.000, bajo MIN_AMOUNT_COP (150.000)
      });

      const result = await crearPedido(
        "sid-wompi-monto-minimo",
        {
          quote_id: quote.quote_id,
          payment_method: "pago_en_linea",
          delivery_method: "domicilio",
          customer_data: customerData,
        },
        1000000,
      );

      expect(result).toEqual({ order_id: null, status: "wompi_monto_minimo", total: 100000 });
      expect(fetch).not.toHaveBeenCalled();

      const count = await adminPool.query(`SELECT COUNT(*) FROM orders WHERE quote_id = $1`, [
        quote.quote_id,
      ]);
      expect(Number(count.rows[0].count)).toBe(0);

      vi.unstubAllGlobals();
      await adminPool.query(
        `UPDATE settings SET wompi_private_key_encrypted = NULL, wompi_events_secret_encrypted = NULL WHERE id = $1`,
        [settingsId],
      );
    });

    describe("con Wompi configurado", () => {
      beforeEach(async () => {
        await saveWompiConfig({ privateKey: "prv_test_fake", eventsSecret: "test_events_fake" });
        vi.stubGlobal("fetch", vi.fn());
      });

      afterEach(async () => {
        vi.unstubAllGlobals();
        await adminPool.query(
          `UPDATE settings SET wompi_private_key_encrypted = NULL, wompi_events_secret_encrypted = NULL WHERE id = $1`,
          [settingsId],
        );
      });

      it("crea el pedido pendiente de pago y devuelve el link", async () => {
        // Sufijo único por corrida — payment_link_id es PK global en
        // wompi_payment_links, un literal fijo colisionaría entre corridas
        // de test (mismo criterio que TENANT_WHATSAPP_NUMBER en webhook.test.ts).
        const paymentLinkId = `link-test-${Date.now()}`;
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ data: { id: paymentLinkId } }));

        // quantity: 2 (200.000) — por encima de MIN_AMOUNT_COP (150.000).
        const quote = await generarCotizacion(conversationA, customerA, {
          items: [{ variant_id: variantA, quantity: 2 }],
        });

        const result = await crearPedido(
          "sid-wompi-1",
          {
            quote_id: quote.quote_id,
            payment_method: "pago_en_linea",
            delivery_method: "domicilio",
            customer_data: customerData,
          },
          1000000,
        );

        expect(result.status).toBe("confirmed");
        expect(result.payment_link_url).toBe(`https://checkout.wompi.co/l/${paymentLinkId}`);

        const order = await adminPool.query<{
          payment_status: string;
          wompi_payment_link_id: string;
        }>(`SELECT payment_status, wompi_payment_link_id FROM orders WHERE id = $1`, [
          result.order_id,
        ]);
        expect(order.rows[0]).toEqual({ payment_status: "pendiente", wompi_payment_link_id: paymentLinkId });

        const link = await adminPool.query(
          `SELECT order_id FROM wompi_payment_links WHERE payment_link_id = $1`,
          [paymentLinkId],
        );
        expect(link.rows[0]).toMatchObject({ order_id: result.order_id });
      });

      it("si Wompi rechaza la creación del link, no crea ningún pedido", async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "unauthorized" }, false, 401));

        // quantity: 2 (200.000) — por encima de MIN_AMOUNT_COP (150.000),
        // para que el chequeo de monto mínimo no corte antes de llegar a
        // llamar a Wompi (que es lo que este test quiere ejercitar).
        const quote = await generarCotizacion(conversationA, customerA, {
          items: [{ variant_id: variantA, quantity: 2 }],
        });

        await expect(
          crearPedido(
            "sid-wompi-2",
            {
              quote_id: quote.quote_id,
              payment_method: "pago_en_linea",
              delivery_method: "domicilio",
              customer_data: customerData,
            },
            1000000,
          ),
        ).rejects.toThrow(/401/);

        const count = await adminPool.query(`SELECT COUNT(*) FROM orders WHERE quote_id = $1`, [
          quote.quote_id,
        ]);
        expect(Number(count.rows[0].count)).toBe(0);
      });
    });
  });

  describe("captura progresiva de datos de cliente (Fase 15, ver ADR-033)", () => {
    it("cliente nuevo sin customer_data: 'faltan_datos_cliente' con missing_fields completo y existing_data null", async () => {
      const quote = await generarCotizacion(conversationB, customerB, {
        items: [{ variant_id: variantA, quantity: 1 }],
      });

      const result = await crearPedido(
        "sid-datos-1",
        { quote_id: quote.quote_id, payment_method: "transferencia", delivery_method: "domicilio" },
        1000000,
      );

      // customerB ya existe como fila en `customers` (se crea al primer
      // mensaje de WhatsApp, ver memory.ts) — "cliente nuevo" en la
      // práctica significa esa fila sin address/id_document/full_name
      // todavía, no la ausencia total de la fila (eso solo pasaría con un
      // customer_id que no existiera, lo cual no ocurre en este flujo:
      // quote.customer_id siempre referencia una fila real).
      expect(result).toEqual({
        order_id: null,
        status: "faltan_datos_cliente",
        total: 100000,
        missing_fields: ["address", "id_document", "full_name"],
        // `phone` no falta: por WhatsApp la dirección del canal ya es el
        // teléfono (Fase 19, Etapa C1).
        existing_data: {
          address: null,
          id_document: null,
          full_name: null,
          municipality: null,
          city: null,
          phone: "+3040000002",
        },
      });

      const count = await adminPool.query(`SELECT COUNT(*) FROM orders WHERE quote_id = $1`, [
        quote.quote_id,
      ]);
      expect(Number(count.rows[0].count)).toBe(0);
    });

    it("customer_data con save_permanently true persiste en customers y en el snapshot de orders", async () => {
      const quote = await generarCotizacion(conversationB, customerB, {
        items: [{ variant_id: variantA, quantity: 1 }],
      });

      const result = await crearPedido(
        "sid-datos-2",
        {
          quote_id: quote.quote_id,
          payment_method: "transferencia",
          delivery_method: "domicilio",
          customer_data: {
            address: "Carrera 10 # 20-30",
            id_document: "987654321",
            full_name: "Cliente B De Prueba",
            municipality: "Envigado",
            city: "Medellín",
            save_permanently: true,
          },
        },
        1000000,
      );

      expect(result.status).toBe("confirmed");

      const customer = await adminPool.query(
        `SELECT address, id_document, full_name, municipality, city FROM customers WHERE id = $1`,
        [customerB],
      );
      expect(customer.rows[0]).toEqual({
        address: "Carrera 10 # 20-30",
        id_document: "987654321",
        full_name: "Cliente B De Prueba",
        municipality: "Envigado",
        city: "Medellín",
      });

      const order = await adminPool.query(
        `SELECT delivery_address, delivery_id_document, delivery_full_name, delivery_municipality, delivery_city FROM orders WHERE id = $1`,
        [result.order_id],
      );
      expect(order.rows[0]).toEqual({
        delivery_address: "Carrera 10 # 20-30",
        delivery_id_document: "987654321",
        delivery_full_name: "Cliente B De Prueba",
        delivery_municipality: "Envigado",
        delivery_city: "Medellín",
      });
    });

    it("cliente con datos ya guardados sin customer_data: 'faltan_datos_cliente' con existing_data poblado", async () => {
      // Depende del test anterior (save_permanently true) para que customerB
      // ya tenga datos guardados — mismo customerB, misma corrida.
      const quote = await generarCotizacion(conversationB, customerB, {
        items: [{ variant_id: variantA, quantity: 1 }],
      });

      const result = await crearPedido(
        "sid-datos-3",
        { quote_id: quote.quote_id, payment_method: "transferencia", delivery_method: "domicilio" },
        1000000,
      );

      expect(result).toEqual({
        order_id: null,
        status: "faltan_datos_cliente",
        total: 100000,
        missing_fields: [],
        existing_data: {
          address: "Carrera 10 # 20-30",
          id_document: "987654321",
          full_name: "Cliente B De Prueba",
          municipality: "Envigado",
          city: "Medellín",
          phone: "+3040000002",
        },
      });
    });

    it("save_permanently false no toca customers pero sí guarda el snapshot en orders", async () => {
      const quote = await generarCotizacion(conversationA, customerA, {
        items: [{ variant_id: variantA, quantity: 1 }],
      });

      const result = await crearPedido(
        "sid-datos-4",
        {
          quote_id: quote.quote_id,
          payment_method: "transferencia",
          delivery_method: "domicilio",
          customer_data: {
            address: "Dirección temporal solo para este pedido",
            id_document: "111222333",
            full_name: "Entrega Puntual",
            save_permanently: false,
          },
        },
        1000000,
      );

      expect(result.status).toBe("confirmed");

      // customerA nunca pasó por save_permanently true en ningún test de
      // este archivo — debe seguir sin datos de entrega guardados.
      const customer = await adminPool.query(
        `SELECT address, id_document, full_name FROM customers WHERE id = $1`,
        [customerA],
      );
      expect(customer.rows[0]).toEqual({ address: null, id_document: null, full_name: null });

      const order = await adminPool.query(
        `SELECT delivery_address, delivery_id_document, delivery_full_name FROM orders WHERE id = $1`,
        [result.order_id],
      );
      expect(order.rows[0]).toEqual({
        delivery_address: "Dirección temporal solo para este pedido",
        delivery_id_document: "111222333",
        delivery_full_name: "Entrega Puntual",
      });
    });
  });

  describe("campaña once_per_customer (Fase 17, ver aplicarPromocion.ts)", () => {
    let customerC: string;
    let conversationC: string;
    let productC: string;
    let variantC: string;
    let promotionId: string;

    beforeAll(async () => {
      const customer = await adminPool.query<{ id: string }>(
        `INSERT INTO customers (external_id, contact_phone) VALUES ('whatsapp:+3040000003', '+3040000003') RETURNING id`,
      );
      customerC = customer.rows[0]!.id;
      const conversation = await adminPool.query<{ id: string }>(
        `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
        [customerC],
      );
      conversationC = conversation.rows[0]!.id;

      const product = await seedProduct(adminPool, {
        sku: "CASCO-CAMPANA-PEDIDO",
        name: "Casco campaña pedido",
        price: 100000,
        stock: 50,
      });
      productC = product.productId;
      variantC = product.variantId;

      const promo = await adminPool.query<{ id: string }>(
        `INSERT INTO promotions (type, rules, active) VALUES ('campaña', $1, true) RETURNING id`,
        [JSON.stringify({ kind: "campaña", label: "bienvenida", discount_pct: 15, once_per_customer: true })],
      );
      promotionId = promo.rows[0]!.id;
    });

    afterAll(async () => {
      await adminPool.query(`DELETE FROM promotion_redemptions WHERE promotion_id = $1`, [promotionId]);
      await adminPool.query(
        `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = $1)`,
        [conversationC],
      );
      await adminPool.query(`DELETE FROM orders WHERE conversation_id = $1`, [conversationC]);
      await adminPool.query(`UPDATE quotes SET applied_promotion_id = NULL WHERE applied_promotion_id = $1`, [
        promotionId,
      ]);
      await adminPool.query(`DELETE FROM promotions WHERE id = $1`, [promotionId]);
      await adminPool.query(
        `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`,
        [conversationC],
      );
      await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationC]);
      await deleteProduct(adminPool, productC);
      await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationC]);
      await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerC]);
    });

    it("confirmar un pedido con una campaña aplicada registra la redención", async () => {
      const quote = await generarCotizacion(conversationC, customerC, {
        items: [{ variant_id: variantC, quantity: 1 }],
      });
      const applied = await aplicarPromocion({ quote_id: quote.quote_id });
      expect(applied.promotion_applied).toMatchObject({ id: promotionId, kind: "campaña" });

      const result = await crearPedido(
        "sid-campana-1",
        {
          quote_id: quote.quote_id,
          payment_method: "transferencia",
          delivery_method: "domicilio",
          customer_data: customerData,
        },
        1000000,
      );

      expect(result.status).toBe("confirmed");

      const redemption = await adminPool.query(
        `SELECT promotion_id, customer_id, order_id FROM promotion_redemptions WHERE promotion_id = $1`,
        [promotionId],
      );
      expect(redemption.rows).toHaveLength(1);
      expect(redemption.rows[0]).toMatchObject({
        promotion_id: promotionId,
        customer_id: customerC,
        order_id: result.order_id,
      });
    });
  });
});

describe("crearPedido — datos del cliente entre canales (Fase 19, Etapa C1)", () => {
  const TELEFONO = "+573040000900";
  let customerWapp: string;
  let customerIg: string;
  let conversationIg: string;

  beforeAll(async () => {
    // El mismo humano, dos identidades de canal. La de WhatsApp ya compró y
    // tiene sus datos de entrega guardados; la de Instagram acaba de escribir
    // y solo dejó su teléfono.
    const wapp = await adminPool.query<{ id: string }>(
      `INSERT INTO customers (channel, external_id, contact_phone, address, id_document, full_name, city)
       VALUES ('whatsapp', $1, $2, 'Calle 100 # 5-5', '111222333', 'Rob Aguilar', 'Medellín')
       RETURNING id`,
      [`whatsapp:${TELEFONO}`, TELEFONO],
    );
    customerWapp = wapp.rows[0]!.id;

    const ig = await adminPool.query<{ id: string }>(
      `INSERT INTO customers (channel, external_id, contact_phone)
       VALUES ('instagram', '17841400000000900', $1) RETURNING id`,
      [TELEFONO],
    );
    customerIg = ig.rows[0]!.id;

    const conv = await adminPool.query<{ id: string }>(
      `INSERT INTO conversations (customer_id, channel) VALUES ($1, 'instagram') RETURNING id`,
      [customerIg],
    );
    conversationIg = conv.rows[0]!.id;
  });

  afterAll(async () => {
    await adminPool.query(
      `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`,
      [conversationIg],
    );
    await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationIg]);
    await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationIg]);
    await adminPool.query(`DELETE FROM customers WHERE id IN ($1, $2)`, [customerWapp, customerIg]);
  });

  it("reusa los datos de entrega de la otra identidad cuando el teléfono coincide", async () => {
    const quote = await generarCotizacion(conversationIg, customerIg, {
      items: [{ variant_id: variantA, quantity: 1 }],
    });

    const result = await crearPedido(
      "sid-c1-cruce",
      { quote_id: quote.quote_id, payment_method: "transferencia", delivery_method: "domicilio" },
      1000000,
    );

    // No confirma nada por sí solo: el modelo tiene que confirmárselos al
    // cliente igual que con cualquier dato guardado (ADR-033). Lo que evita
    // es volver a pedirle cédula y dirección a alguien que ya las dio.
    expect(result.status).toBe("faltan_datos_cliente");
    expect(result.missing_fields).toEqual([]);
    expect(result.existing_data).toEqual({
      address: "Calle 100 # 5-5",
      id_document: "111222333",
      full_name: "Rob Aguilar",
      municipality: null,
      city: "Medellín",
      phone: TELEFONO,
    });
  });

  it("no cruza datos con un cliente cuyo teléfono no coincide", async () => {
    const otro = await adminPool.query<{ id: string }>(
      `INSERT INTO customers (channel, external_id, contact_phone)
       VALUES ('instagram', '17841400000000901', '+573040000999') RETURNING id`,
    );
    const otroId = otro.rows[0]!.id;
    const conv = await adminPool.query<{ id: string }>(
      `INSERT INTO conversations (customer_id, channel) VALUES ($1, 'instagram') RETURNING id`,
      [otroId],
    );
    const convId = conv.rows[0]!.id;

    const quote = await generarCotizacion(convId, otroId, {
      items: [{ variant_id: variantA, quantity: 1 }],
    });
    const result = await crearPedido(
      "sid-c1-sin-cruce",
      { quote_id: quote.quote_id, payment_method: "transferencia", delivery_method: "domicilio" },
      1000000,
    );

    expect(result.missing_fields).toEqual(["address", "id_document", "full_name"]);
    expect(result.existing_data).toMatchObject({ address: null, phone: "+573040000999" });

    await adminPool.query(
      `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`,
      [convId],
    );
    await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [convId]);
    await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [convId]);
    await adminPool.query(`DELETE FROM customers WHERE id = $1`, [otroId]);
  });

  it("pide el teléfono cuando el canal no lo trae y el cliente no lo dio", async () => {
    const sinTel = await adminPool.query<{ id: string }>(
      `INSERT INTO customers (channel, external_id) VALUES ('instagram', '17841400000000902') RETURNING id`,
    );
    const sinTelId = sinTel.rows[0]!.id;
    const conv = await adminPool.query<{ id: string }>(
      `INSERT INTO conversations (customer_id, channel) VALUES ($1, 'instagram') RETURNING id`,
      [sinTelId],
    );
    const convId = conv.rows[0]!.id;

    const quote = await generarCotizacion(convId, sinTelId, {
      items: [{ variant_id: variantA, quantity: 1 }],
    });
    const result = await crearPedido(
      "sid-c1-sin-telefono",
      { quote_id: quote.quote_id, payment_method: "transferencia", delivery_method: "domicilio" },
      1000000,
    );

    expect(result.missing_fields).toContain("phone");

    // Y al darlo queda guardado, que es lo que permite reconocerlo si vuelve
    // por otro canal.
    await crearPedido(
      "sid-c1-con-telefono",
      {
        quote_id: quote.quote_id,
        payment_method: "transferencia",
        delivery_method: "domicilio",
        customer_data: { ...customerData, phone: TELEFONO, save_permanently: true },
      },
      1000000,
    );
    const fila = await adminPool.query<{ contact_phone: string | null }>(
      `SELECT contact_phone FROM customers WHERE id = $1`,
      [sinTelId],
    );
    expect(fila.rows[0]!.contact_phone).toBe(TELEFONO);

    await adminPool.query(
      `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = $1)`,
      [convId],
    );
    await adminPool.query(`DELETE FROM orders WHERE conversation_id = $1`, [convId]);
    await adminPool.query(
      `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`,
      [convId],
    );
    await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [convId]);
    await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [convId]);
    await adminPool.query(`DELETE FROM customers WHERE id = $1`, [sinTelId]);
  });
});
