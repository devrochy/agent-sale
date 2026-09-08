import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { crearPedido } from "../../../src/domains/commerce/crearPedido.js";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import { cancelarPedido } from "../../../src/domains/commerce/cancelarPedido.js";
import {
  actualizarMetodoPagoPedido,
  pedirCambioMetodoPago,
} from "../../../src/domains/commerce/cambiarMetodoPagoPedido.js";
import {
  invalidateConnectionsCache,
  saveConnection,
} from "../../../src/shared/db/connectionsDirectory.js";
import { createTemplateRecord } from "../../../src/shared/db/whatsappTemplatesDirectory.js";
import { saveTransferAccounts, saveWompiConfig } from "../../../src/shared/db/settingsDirectory.js";
import { createAdmin } from "../../../src/admin/auth/adminsDirectory.js";
import { hashPassword } from "../../../src/admin/auth/passwordHash.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { deleteProduct, seedProduct } from "../../helpers/seedCatalog.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const PHONE = "whatsapp:+573080000001";
const customerData = {
  address: "Calle 1 # 2-34",
  id_document: "123456789",
  full_name: "Cliente Cambio Pago",
  save_permanently: false,
};

let connectionId: string;
let adminId: string;
let customerId: string;
let conversationId: string;
let productId: string;
let variantId: string;
let settingsId: string;
const fetchMock = vi.fn();

beforeAll(async () => {
  const settings = await adminPool.query<{ id: string }>(
    `INSERT INTO settings (name) VALUES ('Cambiar Metodo Pago Test') RETURNING id`,
  );
  settingsId = settings.rows[0]!.id;

  const passwordHash = await hashPassword("clave-de-prueba-cambiar-pago");
  adminId = await createAdmin("admin-cambiar-pago", "cambiar-pago@formotos.test", passwordHash, "master", null);

  connectionId = await saveConnection({
    channel: "whatsapp",
    provider: "meta",
    label: "WhatsApp Cambiar Pago Test · Meta",
    externalId: "555666777888999",
    displayAddress: "+57 300 444 5555",
    credentials: {
      phoneNumberId: "555666777888999",
      wabaId: "waba-cambiar-pago-test",
      accessToken: "token-cambiar-pago-test",
      appSecret: "secreto-cambiar-pago-test",
      verifyToken: "verify-cambiar-pago-test",
    },
  });

  const templateId = await createTemplateRecord({
    connectionId,
    name: "metodo_pago",
    category: "UTILITY",
    language: "es",
    components: [
      { type: "BODY", text: "Ya casi terminamos, {{1}}! Para tu pedido por {{2}}, ¿cómo preferís pagar?" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Transferencia" },
          { type: "QUICK_REPLY", text: "Pago en línea" },
          { type: "QUICK_REPLY", text: "Contra entrega" },
        ],
      },
    ],
    createdByAdminId: adminId,
  });
  await adminPool.query(`UPDATE whatsapp_templates SET status = 'approved' WHERE id = $1`, [templateId]);

  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id) VALUES ($1) RETURNING id`,
    [PHONE],
  );
  customerId = customer.rows[0]!.id;
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id, connection_id, channel) VALUES ($1, $2, 'whatsapp') RETURNING id`,
    [customerId, connectionId],
  );
  conversationId = conversation.rows[0]!.id;

  const product = await seedProduct(adminPool, {
    sku: "CAMBIO-PAGO-1",
    name: "Casco cambio de pago",
    price: 200000,
    stock: 20,
  });
  productId = product.productId;
  variantId = product.variantId;
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM wompi_payment_links WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = $1)`, [conversationId]);
  await adminPool.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = $1)`, [conversationId]);
  await adminPool.query(`DELETE FROM orders WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`, [conversationId]);
  await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
  await deleteProduct(adminPool, productId);
  await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  // ON DELETE CASCADE en whatsapp_templates.connection_id se lleva la plantilla.
  await adminPool.query(`DELETE FROM channel_connections WHERE id = $1`, [connectionId]);
  invalidateConnectionsCache();
  await adminPool.query(`DELETE FROM admin_permissions WHERE admin_id = $1`, [adminId]);
  await adminPool.query(`DELETE FROM admins WHERE id = $1`, [adminId]);
  await adminPool.query(`DELETE FROM settings WHERE id = $1`, [settingsId]);
  await adminPool.end();
  await appPool.end();
});

async function nuevoPedidoAbierto(): Promise<string> {
  const quote = await generarCotizacion(conversationId, customerId, {
    items: [{ variant_id: variantId, quantity: 1 }],
  });
  const created = await crearPedido(
    `sid-cambiar-pago-${Date.now()}-${Math.random()}`,
    {
      quote_id: quote.quote_id,
      payment_method: "efectivo_contraentrega",
      delivery_method: "domicilio",
      customer_data: customerData,
    },
    1000000,
  );
  return created.order_id!;
}

describe("pedirCambioMetodoPago", () => {
  it("manda la plantilla metodo_pago atada al order_id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.cambio-pago-1" }] }));
    const orderId = await nuevoPedidoAbierto();

    const result = await pedirCambioMetodoPago({ order_id: orderId });

    expect(result).toEqual({ order_id: orderId, status: "enviado" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.template.name).toBe("metodo_pago");
    expect(payload.template.components[0].parameters[1].text).toBe("$200.000");
  });

  it("pedido no abierto devuelve pedido_no_abierto, sin llamar a Meta", async () => {
    const orderId = await nuevoPedidoAbierto();
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.cancelado-cambio-pago" }] }));
    await cancelarPedido({ order_id: orderId });
    fetchMock.mockReset();

    const result = await pedirCambioMetodoPago({ order_id: orderId });

    expect(result).toEqual({ order_id: orderId, status: "pedido_no_abierto" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("actualizarMetodoPagoPedido", () => {
  it("cambia a transferencia con cuentas configuradas: actualiza el pedido y manda los datos", async () => {
    await saveTransferAccounts([
      {
        entity: "Bancolombia",
        accountType: "Ahorros",
        accountNumber: "111-222333-44",
        holderName: "ForMotos SAS",
        holderDocument: "",
        active: true,
      },
    ]);
    const orderId = await nuevoPedidoAbierto();
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.cambio-pago-transferencia" }] }));

    const result = await actualizarMetodoPagoPedido({ order_id: orderId, payment_method: "transferencia" });

    expect(result).toEqual({ order_id: orderId, status: "actualizado", transfer_details_sent: true });
    const order = await adminPool.query<{ payment_method: string; payment_status: string }>(
      `SELECT payment_method, payment_status FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0]).toEqual({ payment_method: "transferencia", payment_status: "pendiente" });

    await saveTransferAccounts([]);
  });

  it("cambia a transferencia sin cuentas configuradas: actualiza igual pero transfer_details_sent es false", async () => {
    await saveTransferAccounts([]);
    const orderId = await nuevoPedidoAbierto();

    const result = await actualizarMetodoPagoPedido({ order_id: orderId, payment_method: "transferencia" });

    expect(result).toEqual({ order_id: orderId, status: "actualizado", transfer_details_sent: false });
  });

  it("cambia a pago_en_linea sin Wompi configurado: devuelve wompi_no_configurado sin tocar el pedido", async () => {
    const orderId = await nuevoPedidoAbierto();

    const result = await actualizarMetodoPagoPedido({ order_id: orderId, payment_method: "pago_en_linea" });

    expect(result).toEqual({ order_id: orderId, status: "wompi_no_configurado" });
    const order = await adminPool.query<{ payment_method: string }>(
      `SELECT payment_method FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0]!.payment_method).toBe("efectivo_contraentrega");
  });

  describe("con Wompi configurado", () => {
    beforeEach(async () => {
      await saveWompiConfig({ privateKey: "prv_test_fake", eventsSecret: "test_events_fake" });
    });

    afterEach(async () => {
      await adminPool.query(
        `UPDATE settings SET wompi_private_key_encrypted = NULL, wompi_events_secret_encrypted = NULL WHERE id = $1`,
        [settingsId],
      );
    });

    it("total por debajo del mínimo devuelve wompi_monto_minimo sin llamar a Wompi", async () => {
      const orderId = await nuevoPedidoAbierto(); // total = $200.000... por encima del mínimo real, usar un pedido de monto bajo
      // El producto de este archivo cuesta $200.000 (por encima de MIN_AMOUNT_COP) — se fuerza el total para probar el mínimo.
      await adminPool.query(`UPDATE orders SET total = 50000 WHERE id = $1`, [orderId]);

      const result = await actualizarMetodoPagoPedido({ order_id: orderId, payment_method: "pago_en_linea" });

      expect(result).toEqual({ order_id: orderId, status: "wompi_monto_minimo" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("crea el link de pago y lo deja guardado en el pedido", async () => {
      const paymentLinkId = `link-cambio-pago-${Date.now()}`;
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: paymentLinkId } }));
      const orderId = await nuevoPedidoAbierto();

      const result = await actualizarMetodoPagoPedido({ order_id: orderId, payment_method: "pago_en_linea" });

      expect(result).toEqual({
        order_id: orderId,
        status: "actualizado",
        payment_link_url: `https://checkout.wompi.co/l/${paymentLinkId}`,
      });
      const order = await adminPool.query<{
        payment_method: string;
        payment_status: string;
        wompi_payment_link_id: string;
      }>(`SELECT payment_method, payment_status, wompi_payment_link_id FROM orders WHERE id = $1`, [orderId]);
      expect(order.rows[0]).toEqual({
        payment_method: "pago_en_linea",
        payment_status: "pendiente",
        wompi_payment_link_id: paymentLinkId,
      });
      const link = await adminPool.query(`SELECT order_id FROM wompi_payment_links WHERE payment_link_id = $1`, [
        paymentLinkId,
      ]);
      expect(link.rows[0]).toMatchObject({ order_id: orderId });
    });
  });

  it("pedido no abierto devuelve pedido_no_abierto", async () => {
    const orderId = await nuevoPedidoAbierto();
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.cancelado-cambio-pago-2" }] }));
    await cancelarPedido({ order_id: orderId });

    const result = await actualizarMetodoPagoPedido({ order_id: orderId, payment_method: "transferencia" });

    expect(result).toEqual({ order_id: orderId, status: "pedido_no_abierto" });
  });
});
