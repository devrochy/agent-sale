import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agregarItemPedido } from "../../../src/domains/commerce/agregarItemPedido.js";
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
let settingsId: string;

async function crearPedidoAbierto(messageSid: string, quantity = 1): Promise<{ orderId: string; total: number }> {
  const quote = await generarCotizacion(conversationA, customerA, {
    items: [{ variant_id: variantA, quantity }],
  });
  const result = await crearPedido(
    messageSid,
    {
      quote_id: quote.quote_id,
      payment_method: "transferencia",
      delivery_method: "domicilio",
      customer_data: customerData,
    },
    1000000,
  );
  return { orderId: result.order_id!, total: result.total };
}

beforeAll(async () => {
  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id) VALUES ('3040000003') RETURNING id`,
  );
  customerA = customer.rows[0]!.id;
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerA],
  );
  conversationA = conversation.rows[0]!.id;

  const product = await seedProduct(adminPool, {
    sku: "CASCO-AGREGAR-ITEM",
    name: "Casco agregar item",
    price: 100000,
    stock: 50,
  });
  productA = product.productId;
  variantA = product.variantId;

  const settings = await adminPool.query<{ id: string }>(
    `INSERT INTO settings (name) VALUES ('Agregar Item Pedido Test') RETURNING id`,
  );
  settingsId = settings.rows[0]!.id;
});

afterAll(async () => {
  await adminPool.query(
    `DELETE FROM order_item_batches WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = $1)`,
    [conversationA],
  );
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
  await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationA]);
  await deleteProduct(adminPool, productA);
  await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerA]);
  await adminPool.query(`DELETE FROM settings WHERE id = $1`, [settingsId]);
  await adminPool.end();
  await appPool.end();
});

describe("agregarItemPedido", () => {
  it("agrega item a un pedido abierto: recalcula total, descuenta stock, devuelve items_agregados", async () => {
    const { orderId, total } = await crearPedidoAbierto("sid-agregar-1", 1); // total inicial 100.000

    const stockBefore = await adminPool.query<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM inventory WHERE variant_id = $1`,
      [variantA],
    );

    const result = await agregarItemPedido(
      "sid-agregar-1-lote",
      { order_id: orderId, items: [{ variant_id: variantA, quantity: 2 }] },
      1000000,
    );

    expect(result.status).toBe("actualizado");
    expect(result.total).toBe(total + 200000);
    expect(result.items_agregados).toEqual([
      { variant_id: variantA, name: "Casco agregar item", quantity: 2, unit_price: 100000, line_total: 200000 },
    ]);

    const order = await adminPool.query<{ total: string }>(`SELECT total FROM orders WHERE id = $1`, [orderId]);
    expect(Number(order.rows[0]!.total)).toBe(total + 200000);

    const items = await adminPool.query(`SELECT variant_id, quantity FROM order_items WHERE order_id = $1`, [
      orderId,
    ]);
    expect(items.rows).toHaveLength(2); // el item original + el agregado

    const stockAfter = await adminPool.query<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM inventory WHERE variant_id = $1`,
      [variantA],
    );
    expect(stockAfter.rows[0]!.stock_quantity).toBe(stockBefore.rows[0]!.stock_quantity - 2);
  });

  it("el mismo messageSid reintentado sobre el mismo pedido devuelve 'duplicate' sin duplicar filas ni descontar stock de nuevo", async () => {
    const { orderId } = await crearPedidoAbierto("sid-agregar-2", 1);

    const first = await agregarItemPedido(
      "sid-agregar-2-lote",
      { order_id: orderId, items: [{ variant_id: variantA, quantity: 1 }] },
      1000000,
    );
    const stockAfterFirst = await adminPool.query<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM inventory WHERE variant_id = $1`,
      [variantA],
    );

    const second = await agregarItemPedido(
      "sid-agregar-2-lote",
      { order_id: orderId, items: [{ variant_id: variantA, quantity: 1 }] },
      1000000,
    );

    expect(second.status).toBe("duplicate");
    expect(second.total).toBe(first.total);

    const batches = await adminPool.query(`SELECT id FROM order_item_batches WHERE order_id = $1`, [orderId]);
    expect(batches.rows).toHaveLength(1);

    const items = await adminPool.query(`SELECT id FROM order_items WHERE order_id = $1`, [orderId]);
    expect(items.rows).toHaveLength(2); // el original + el único lote real

    const stockAfterSecond = await adminPool.query<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM inventory WHERE variant_id = $1`,
      [variantA],
    );
    expect(stockAfterSecond.rows[0]!.stock_quantity).toBe(stockAfterFirst.rows[0]!.stock_quantity);
  });

  it("un pedido que no está 'abierto' devuelve 'pedido_no_abierto' sin insertar nada", async () => {
    const { orderId } = await crearPedidoAbierto("sid-agregar-3", 1);
    await adminPool.query(`UPDATE orders SET status = 'despachado' WHERE id = $1`, [orderId]);

    const result = await agregarItemPedido(
      "sid-agregar-3-lote",
      { order_id: orderId, items: [{ variant_id: variantA, quantity: 1 }] },
      1000000,
    );

    expect(result.status).toBe("pedido_no_abierto");
    expect(result.items_agregados).toEqual([]);

    const items = await adminPool.query(`SELECT id FROM order_items WHERE order_id = $1`, [orderId]);
    expect(items.rows).toHaveLength(1); // solo el item original de crearPedido
  });

  it("si el nuevo total supera montoAltoThreshold, devuelve 'monto_alto' sin insertar nada", async () => {
    const { orderId, total } = await crearPedidoAbierto("sid-agregar-4", 1); // total inicial 100.000

    const stockBefore = await adminPool.query<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM inventory WHERE variant_id = $1`,
      [variantA],
    );

    const result = await agregarItemPedido(
      "sid-agregar-4-lote",
      { order_id: orderId, items: [{ variant_id: variantA, quantity: 5 }] }, // +500.000
      300000, // umbral menor que total + subtotal nuevo (600.000)
    );

    expect(result).toEqual({ order_id: orderId, status: "monto_alto", items_agregados: [], total: total + 500000 });

    const order = await adminPool.query<{ total: string }>(`SELECT total FROM orders WHERE id = $1`, [orderId]);
    expect(Number(order.rows[0]!.total)).toBe(total);

    const items = await adminPool.query(`SELECT id FROM order_items WHERE order_id = $1`, [orderId]);
    expect(items.rows).toHaveLength(1); // solo el item original

    const stockAfter = await adminPool.query<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM inventory WHERE variant_id = $1`,
      [variantA],
    );
    expect(stockAfter.rows[0]!.stock_quantity).toBe(stockBefore.rows[0]!.stock_quantity);
  });

  describe("pago_en_linea con link pendiente (Fase 15, ver ADR-033)", () => {
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

    it("regenera el link de pago con el total actualizado", async () => {
      const firstLinkId = `link-agregar-inicial-${Date.now()}`;
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { id: firstLinkId } }));

      // quantity: 2 (200.000) — por encima de MIN_AMOUNT_COP (150.000).
      const quote = await generarCotizacion(conversationA, customerA, {
        items: [{ variant_id: variantA, quantity: 2 }],
      });
      const created = await crearPedido(
        "sid-agregar-5",
        {
          quote_id: quote.quote_id,
          payment_method: "pago_en_linea",
          delivery_method: "domicilio",
          customer_data: customerData,
        },
        1000000,
      );
      expect(created.status).toBe("confirmed");

      const secondLinkId = `link-agregar-actualizado-${Date.now()}`;
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { id: secondLinkId } }));

      const result = await agregarItemPedido(
        "sid-agregar-5-lote",
        { order_id: created.order_id!, items: [{ variant_id: variantA, quantity: 1 }] },
        1000000,
      );

      expect(result.status).toBe("actualizado");
      expect(result.total).toBe(created.total + 100000);
      expect(result.payment_link_url).toBe(`https://checkout.wompi.co/l/${secondLinkId}`);

      const order = await adminPool.query<{ wompi_payment_link_id: string }>(
        `SELECT wompi_payment_link_id FROM orders WHERE id = $1`,
        [created.order_id],
      );
      expect(order.rows[0]!.wompi_payment_link_id).toBe(secondLinkId);

      const link = await adminPool.query(`SELECT order_id FROM wompi_payment_links WHERE payment_link_id = $1`, [
        secondLinkId,
      ]);
      expect(link.rows[0]).toMatchObject({ order_id: created.order_id });
    });
  });
});
