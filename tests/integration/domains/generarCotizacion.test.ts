import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let conversationA: string;
let customerA: string;
let productA: string;

beforeAll(async () => {
  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (phone_number) VALUES ('3020000001') RETURNING id`,
  );
  customerA = customer.rows[0]!.id;
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerA],
  );
  conversationA = conversation.rows[0]!.id;

  const product = await adminPool.query<{ id: string }>(
    `INSERT INTO products (sku, name, price) VALUES ('CASCO-COT', 'Casco cotización', 100000) RETURNING id`,
  );
  productA = product.rows[0]!.id;
  await adminPool.query(`INSERT INTO inventory (product_id, stock_quantity) VALUES ($1, 10)`, [
    productA,
  ]);
});

afterAll(async () => {
  await adminPool.query(
    `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`,
    [conversationA],
  );
  await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationA]);
  await adminPool.query(`DELETE FROM inventory WHERE product_id = $1`, [productA]);
  await adminPool.query(`DELETE FROM products WHERE id = $1`, [productA]);
  await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationA]);
  await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerA]);
  await adminPool.end();
  await appPool.end();
});

describe("generarCotizacion", () => {
  it("crea una cotización con subtotal calculado a partir del precio real", async () => {
    const result = await generarCotizacion(conversationA, customerA, {
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
      generarCotizacion(conversationA, customerA, {
        items: [{ product_id: productA, quantity: 999 }],
      }),
    ).rejects.toThrow(/Stock insuficiente/);
  });

  it("falla si el producto no existe", async () => {
    await expect(
      generarCotizacion(conversationA, customerA, {
        items: [{ product_id: "00000000-0000-0000-0000-000000000000", quantity: 1 }],
      }),
    ).rejects.toThrow(/Producto no encontrado/);
  });

  it("falla si la lista de items está vacía", async () => {
    await expect(generarCotizacion(conversationA, customerA, { items: [] })).rejects.toThrow();
  });
});
