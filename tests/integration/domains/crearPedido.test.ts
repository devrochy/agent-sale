import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { crearPedido } from "../../../src/domains/commerce/crearPedido.js";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { saveWompiConfig } from "../../../src/shared/db/settingsDirectory.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let conversationA: string;
let customerA: string;
let productA: string;
// La sección "pago_en_linea" necesita una fila de settings para
// getWompiConfig/saveWompiConfig (settings es singleton — se siembra acá,
// no en el beforeAll general, porque el resto de los tests de este
// archivo no la necesitan).
let settingsId: string;

beforeAll(async () => {
  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (phone_number) VALUES ('3040000001') RETURNING id`,
  );
  customerA = customer.rows[0]!.id;
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerA],
  );
  conversationA = conversation.rows[0]!.id;

  const product = await adminPool.query<{ id: string }>(
    `INSERT INTO products (sku, name, price) VALUES ('CASCO-PEDIDO', 'Casco pedido', 100000) RETURNING id`,
  );
  productA = product.rows[0]!.id;
  await adminPool.query(`INSERT INTO inventory (product_id, stock_quantity) VALUES ($1, 50)`, [
    productA,
  ]);

  const settings = await adminPool.query<{ id: string }>(
    `INSERT INTO settings (name) VALUES ('Crear Pedido Test') RETURNING id`,
  );
  settingsId = settings.rows[0]!.id;
});

afterAll(async () => {
  await adminPool.query(
    `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = $1)`,
    [conversationA],
  );
  await adminPool.query(
    `DELETE FROM wompi_payment_links WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = $1)`,
    [conversationA],
  );
  await adminPool.query(`DELETE FROM orders WHERE conversation_id = $1`, [conversationA]);
  await adminPool.query(
    `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`,
    [conversationA],
  );
  await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationA]);
  await adminPool.query(`DELETE FROM inventory WHERE product_id = $1`, [productA]);
  await adminPool.query(`DELETE FROM products WHERE id = $1`, [productA]);
  await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationA]);
  await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerA]);
  await adminPool.query(`DELETE FROM settings WHERE id = $1`, [settingsId]);
  await adminPool.end();
  await appPool.end();
});

describe("crearPedido", () => {
  it("crea un pedido confirmado a partir de una cotización, copiando los items", async () => {
    const quote = await generarCotizacion(conversationA, customerA, {
      items: [{ product_id: productA, quantity: 2 }],
    });

    const result = await crearPedido(
      "sid-1",
      {
        quote_id: quote.quote_id,
        payment_method: "transferencia",
        delivery_method: "domicilio",
      },
      1000000,
    );

    expect(result.status).toBe("confirmed");
    expect(result.total).toBe(200000);

    const items = await adminPool.query(
      `SELECT product_id, quantity, unit_price FROM order_items WHERE order_id = $1`,
      [result.order_id],
    );
    expect(items.rows).toHaveLength(1);
    expect(items.rows[0]).toMatchObject({ product_id: productA, quantity: 2 });

    const stock = await adminPool.query<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM inventory WHERE product_id = $1`,
      [productA],
    );
    expect(stock.rows[0]!.stock_quantity).toBe(48); // 50 - 2
  });

  it("el mismo message_sid reintentado sobre la misma cotización devuelve el mismo pedido (status duplicate)", async () => {
    const quote = await generarCotizacion(conversationA, customerA, {
      items: [{ product_id: productA, quantity: 1 }],
    });

    const first = await crearPedido(
      "sid-2",
      { quote_id: quote.quote_id, payment_method: "tarjeta", delivery_method: "recoger_en_tienda" },
      1000000,
    );
    const second = await crearPedido(
      "sid-2",
      { quote_id: quote.quote_id, payment_method: "tarjeta", delivery_method: "recoger_en_tienda" },
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
      `SELECT stock_quantity FROM inventory WHERE product_id = $1`,
      [productA],
    );
    expect(stock.rows[0]!.stock_quantity).toBe(47); // 48 - 1 (de este test), no -2
  });

  it("un message_sid distinto sobre una cotización ya convertida en pedido también devuelve 'duplicate' (0..1 quote->order)", async () => {
    const quote = await generarCotizacion(conversationA, customerA, {
      items: [{ product_id: productA, quantity: 1 }],
    });

    const first = await crearPedido(
      "sid-3",
      {
        quote_id: quote.quote_id,
        payment_method: "efectivo_contraentrega",
        delivery_method: "domicilio",
      },
      1000000,
    );
    const second = await crearPedido(
      "sid-distinto",
      {
        quote_id: quote.quote_id,
        payment_method: "efectivo_contraentrega",
        delivery_method: "domicilio",
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
      items: [{ product_id: productA, quantity: 5 }], // 5 x 100.000 = 500.000
    });

    const stockBefore = await adminPool.query<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM inventory WHERE product_id = $1`,
      [productA],
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
      `SELECT stock_quantity FROM inventory WHERE product_id = $1`,
      [productA],
    );
    expect(stockAfter.rows[0]!.stock_quantity).toBe(stockBefore.rows[0]!.stock_quantity);
  });

  describe("pago_en_linea (Fase 12.4, Wompi)", () => {
    it("sin Wompi configurado, devuelve 'wompi_no_configurado' sin crear pedido", async () => {
      const quote = await generarCotizacion(conversationA, customerA, {
        items: [{ product_id: productA, quantity: 1 }],
      });

      const result = await crearPedido(
        "sid-wompi-no-config",
        { quote_id: quote.quote_id, payment_method: "pago_en_linea", delivery_method: "domicilio" },
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
        items: [{ product_id: productA, quantity: 1 }], // 1 x 100.000 = 100.000, bajo MIN_AMOUNT_COP (150.000)
      });

      const result = await crearPedido(
        "sid-wompi-monto-minimo",
        { quote_id: quote.quote_id, payment_method: "pago_en_linea", delivery_method: "domicilio" },
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
          items: [{ product_id: productA, quantity: 2 }],
        });

        const result = await crearPedido(
          "sid-wompi-1",
          { quote_id: quote.quote_id, payment_method: "pago_en_linea", delivery_method: "domicilio" },
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
          items: [{ product_id: productA, quantity: 2 }],
        });

        await expect(
          crearPedido(
            "sid-wompi-2",
            { quote_id: quote.quote_id, payment_method: "pago_en_linea", delivery_method: "domicilio" },
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
});
