import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consultarEstadoPedido } from "../../../src/domains/commerce/consultarEstadoPedido.js";
import { crearPedido } from "../../../src/domains/commerce/crearPedido.js";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { deleteProduct, seedProduct } from "../../helpers/seedCatalog.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const customerData = {
  address: "Calle 1 # 2-34",
  id_document: "123456789",
  full_name: "Cliente Consulta Estado",
  save_permanently: false,
};

let conversationA: string;
let customerA: string;
let conversationB: string;
let customerB: string;
let productId: string;
let variantId: string;
let publicOrderNumberA: string;

beforeAll(async () => {
  const custA = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id) VALUES ('3050000001') RETURNING id`,
  );
  customerA = custA.rows[0]!.id;
  const convA = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerA],
  );
  conversationA = convA.rows[0]!.id;

  const custB = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id) VALUES ('3050000002') RETURNING id`,
  );
  customerB = custB.rows[0]!.id;
  const convB = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerB],
  );
  conversationB = convB.rows[0]!.id;

  const product = await seedProduct(adminPool, {
    sku: "CONSULTA-ESTADO-1",
    name: "Casco consulta estado",
    price: 100000,
    stock: 50,
  });
  productId = product.productId;
  variantId = product.variantId;

  const quote = await generarCotizacion(conversationA, customerA, {
    items: [{ variant_id: variantId, quantity: 1 }],
  });
  const created = await crearPedido(
    "sid-consulta-estado-1",
    {
      quote_id: quote.quote_id,
      payment_method: "transferencia",
      delivery_method: "domicilio",
      customer_data: customerData,
    },
    1000000,
  );
  publicOrderNumberA = created.public_order_number!;
});

afterAll(async () => {
  await adminPool.query(
    `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = $1)`,
    [conversationA],
  );
  await adminPool.query(`DELETE FROM orders WHERE conversation_id = $1`, [conversationA]);
  await adminPool.query(
    `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`,
    [conversationA],
  );
  await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationA]);
  await adminPool.query(`DELETE FROM conversations WHERE id IN ($1, $2)`, [conversationA, conversationB]);
  await deleteProduct(adminPool, productId);
  await adminPool.query(`DELETE FROM customers WHERE id IN ($1, $2)`, [customerA, customerB]);
  await adminPool.end();
  await appPool.end();
});

describe("consultarEstadoPedido", () => {
  it("encuentra el pedido propio con todos los campos", async () => {
    const result = await consultarEstadoPedido(customerA, { public_order_number: publicOrderNumberA });

    expect(result.found).toBe(true);
    expect(result.public_order_number).toBe(publicOrderNumberA);
    expect(result.status).toBe("abierto");
    expect(result.payment_status).toBe("pagado");
    expect(result.delivery_method).toBe("domicilio");
    expect(result.tracking_number).toBeNull();
    expect(result.total).toBe(100000);
    expect(result.items).toEqual([{ name: "Casco consulta estado", quantity: 1 }]);
  });

  it("acepta variantes de formato del número (minúsculas, sin guion, con ceros de menos)", async () => {
    const sinGuion = await consultarEstadoPedido(customerA, {
      public_order_number: publicOrderNumberA.toLowerCase().replace("-", ""),
    });
    expect(sinGuion.found).toBe(true);
    expect(sinGuion.public_order_number).toBe(publicOrderNumberA);
  });

  it("un número que existe pero es de otro cliente devuelve found:false", async () => {
    const result = await consultarEstadoPedido(customerB, { public_order_number: publicOrderNumberA });
    expect(result).toEqual({ found: false });
  });

  it("un número inexistente devuelve found:false", async () => {
    const result = await consultarEstadoPedido(customerA, { public_order_number: "FM-9999" });
    expect(result).toEqual({ found: false });
  });

  it("un número mal formado devuelve found:false sin consultar la base", async () => {
    const result = await consultarEstadoPedido(customerA, { public_order_number: "abc" });
    expect(result).toEqual({ found: false });
  });
});
