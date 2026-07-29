import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearPedido } from "../../../src/domains/commerce/crearPedido.js";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let tenantA: string;
let conversationA: string;
let customerA: string;
let productA: string;

beforeAll(async () => {
  const tenant = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Crear Pedido Test A') RETURNING id`,
  );
  tenantA = tenant.rows[0]!.id;

  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, phone_number) VALUES ($1, '3040000001') RETURNING id`,
    [tenantA],
  );
  customerA = customer.rows[0]!.id;
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id`,
    [tenantA, customerA],
  );
  conversationA = conversation.rows[0]!.id;

  const product = await adminPool.query<{ id: string }>(
    `INSERT INTO products (tenant_id, sku, name, price) VALUES ($1, 'CASCO-PEDIDO', 'Casco pedido', 100000) RETURNING id`,
    [tenantA],
  );
  productA = product.rows[0]!.id;
  await adminPool.query(
    `INSERT INTO inventory (tenant_id, product_id, stock_quantity) VALUES ($1, $2, 50)`,
    [tenantA, productA],
  );
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM order_items WHERE tenant_id = $1`, [tenantA]);
  await adminPool.query(`DELETE FROM orders WHERE tenant_id = $1`, [tenantA]);
  await adminPool.query(`DELETE FROM quote_items WHERE tenant_id = $1`, [tenantA]);
  await adminPool.query(`DELETE FROM quotes WHERE tenant_id = $1`, [tenantA]);
  await adminPool.query(`DELETE FROM inventory WHERE tenant_id = $1`, [tenantA]);
  await adminPool.query(`DELETE FROM products WHERE tenant_id = $1`, [tenantA]);
  await adminPool.query(`DELETE FROM conversations WHERE tenant_id = $1`, [tenantA]);
  await adminPool.query(`DELETE FROM customers WHERE tenant_id = $1`, [tenantA]);
  await adminPool.query(`DELETE FROM tenants WHERE id = $1`, [tenantA]);
  await adminPool.end();
  await appPool.end();
});

describe("crearPedido", () => {
  it("crea un pedido confirmado a partir de una cotización, copiando los items", async () => {
    const quote = await generarCotizacion(tenantA, conversationA, customerA, {
      items: [{ product_id: productA, quantity: 2 }],
    });

    const result = await crearPedido(
      tenantA,
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
    const quote = await generarCotizacion(tenantA, conversationA, customerA, {
      items: [{ product_id: productA, quantity: 1 }],
    });

    const first = await crearPedido(
      tenantA,
      "sid-2",
      { quote_id: quote.quote_id, payment_method: "tarjeta", delivery_method: "recoger_en_tienda" },
      1000000,
    );
    const second = await crearPedido(
      tenantA,
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
    const quote = await generarCotizacion(tenantA, conversationA, customerA, {
      items: [{ product_id: productA, quantity: 1 }],
    });

    const first = await crearPedido(
      tenantA,
      "sid-3",
      {
        quote_id: quote.quote_id,
        payment_method: "efectivo_contraentrega",
        delivery_method: "domicilio",
      },
      1000000,
    );
    const second = await crearPedido(
      tenantA,
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
        tenantA,
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
    const quote = await generarCotizacion(tenantA, conversationA, customerA, {
      items: [{ product_id: productA, quantity: 5 }], // 5 x 100.000 = 500.000
    });

    const stockBefore = await adminPool.query<{ stock_quantity: number }>(
      `SELECT stock_quantity FROM inventory WHERE product_id = $1`,
      [productA],
    );

    const result = await crearPedido(
      tenantA,
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
});
