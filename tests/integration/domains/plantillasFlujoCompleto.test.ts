import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAdmin } from "../../../src/admin/auth/adminsDirectory.js";
import { hashPassword } from "../../../src/admin/auth/passwordHash.js";
import { agregarItemPedido } from "../../../src/domains/commerce/agregarItemPedido.js";
import { cancelarPedido } from "../../../src/domains/commerce/cancelarPedido.js";
import {
  confirmarDomicilioPedido,
  pedirConfirmacionDomicilio,
} from "../../../src/domains/commerce/confirmarDomicilioPedido.js";
import { actualizarDireccionPedido } from "../../../src/domains/commerce/actualizarDireccionPedido.js";
import { confirmarPagoPedido } from "../../../src/domains/commerce/confirmarPagoPedido.js";
import { saveTransferAccounts } from "../../../src/shared/db/settingsDirectory.js";
import { crearPedido } from "../../../src/domains/commerce/crearPedido.js";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import {
  marcarPagoAprobado,
  marcarPagoRechazado,
} from "../../../src/domains/commerce/estadoPedido.js";
import {
  notificarClientePagoAprobado,
  notificarClientePagoRechazado,
} from "../../../src/domains/commerce/notificarPagoCliente.js";
import { preguntarMetodoPago } from "../../../src/domains/commerce/preguntarMetodoPago.js";
import { registrarGuia } from "../../../src/domains/commerce/registrarGuia.js";
import {
  invalidateConnectionsCache,
  saveConnection,
} from "../../../src/shared/db/connectionsDirectory.js";
import { createTemplateRecord } from "../../../src/shared/db/whatsappTemplatesDirectory.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { deleteProduct, seedProduct } from "../../helpers/seedCatalog.js";

/**
 * Cubre el flujo nuevo de plantillas alrededor de un pedido (Fase de "8
 * plantillas nuevas de Meta") de punta a punta a nivel de dominio, sin pasar
 * por el panel: preguntar_metodo_pago, pedir_confirmacion_domicilio (que
 * manda "confirmar_domicilio" sola) → confirmar_domicilio_pedido/
 * actualizar_direccion_pedido (que recién ahí mandan "pedido_confirmado_v3"),
 * el gate de registrarGuia, y las notificaciones de pago aprobado/rechazado
 * y pedido cancelado. Mismo criterio de mock de `fetch` que
 * tests/integration/gateway/admin.test.ts (describe "plantillas"): estas
 * funciones llaman a gateway/channels/meta/templates.ts directo, no pasan
 * por outboundAdapterFor/registry.js.
 */

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const PHONE = "whatsapp:+573070000001";
const fetchMock = vi.fn();

let connectionId: string;
let adminId: string;
let customerId: string;
let conversationId: string;
let productId: string;
let variantId: string;
let settingsId: string;

const customerData = {
  address: "Calle 10 # 20-30",
  id_document: "987654321",
  full_name: "Cliente Plantillas",
  save_permanently: false,
};

async function crearPlantillaAprobada(name: string, components: Record<string, unknown>[]): Promise<void> {
  const id = await createTemplateRecord({
    connectionId,
    name,
    category: "UTILITY",
    language: "es",
    components,
    createdByAdminId: adminId,
  });
  await adminPool.query(`UPDATE whatsapp_templates SET status = 'approved' WHERE id = $1`, [id]);
}

function okJsonResponse(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body };
}

beforeAll(async () => {
  // `settings` es singleton y no nace de ninguna migración — en una base
  // recién migrada (CI) todavía no existe ninguna fila. Mismo patrón que
  // el resto de la suite (procesarComprobante.test.ts, crearPedido.test.ts,
  // etc.): esta fila es de este archivo, se crea acá y se borra en
  // afterAll — sin esto, el describe "confirmar_pago_pedido" de más abajo
  // llama saveTransferAccounts contra una tabla vacía y el UPDATE no toca
  // ninguna fila.
  const settings = await adminPool.query<{ id: string }>(
    `INSERT INTO settings (name) VALUES ('Flujo Plantillas Test') RETURNING id`,
  );
  settingsId = settings.rows[0]!.id;

  const passwordHash = await hashPassword("clave-de-prueba-flujo-plantillas");
  adminId = await createAdmin(
    "admin-flujo-plantillas",
    "flujo-plantillas@formotos.test",
    passwordHash,
    "master",
    null,
  );

  connectionId = await saveConnection({
    channel: "whatsapp",
    provider: "meta",
    label: "WhatsApp Flujo Plantillas Test · Meta",
    externalId: "444555666777888",
    displayAddress: "+57 300 111 2222",
    credentials: {
      phoneNumberId: "444555666777888",
      wabaId: "waba-flujo-test",
      accessToken: "token-flujo-test",
      appSecret: "secreto-flujo-test",
      verifyToken: "verify-flujo-test",
    },
  });

  await crearPlantillaAprobada("metodo_pago", [
    {
      type: "BODY",
      text: "Ya casi terminamos, {{1}}! Para tu pedido por {{2}}, ¿cómo preferís pagar?",
    },
    {
      type: "BUTTONS",
      buttons: [
        { type: "QUICK_REPLY", text: "Transferencia" },
        { type: "QUICK_REPLY", text: "Pago en línea" },
        { type: "QUICK_REPLY", text: "Contra entrega" },
      ],
    },
  ]);
  await crearPlantillaAprobada("confirmar_domicilio", [
    { type: "BODY", text: "Antes de alistar tu pedido #{{1}}, confirmanos: ¿la dirección sigue siendo {{2}}?" },
    { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Confirmar dirección" }] },
  ]);
  await crearPlantillaAprobada("pago_aprobado", [
    { type: "BODY", text: "¡Tu pago del pedido #{{1}} por {{2}} fue aprobado!" },
    {
      type: "BUTTONS",
      buttons: [{ type: "URL", text: "Dejar reseña", url: "https://ejemplo.test/resena/{{1}}", example: ["tok"] }],
    },
  ]);
  await crearPlantillaAprobada("pago_rechazado", [
    { type: "BODY", text: "Tu pago del pedido #{{1}} por {{2}} no pudo procesarse." },
  ]);
  await crearPlantillaAprobada("pedido_cancelado", [
    { type: "BODY", text: "Tu pedido #{{1}} fue cancelado." },
  ]);

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
    sku: "FLUJO-PLANTILLAS-1",
    name: "Casco flujo plantillas",
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
  await adminPool.query(`DELETE FROM order_item_batches WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = $1)`, [conversationId]);
  await adminPool.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = $1)`, [conversationId]);
  await adminPool.query(`DELETE FROM orders WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`, [conversationId]);
  await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM messages WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM review_tokens WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
  await deleteProduct(adminPool, productId);
  await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  // ON DELETE CASCADE en whatsapp_templates.connection_id se lleva las 5 plantillas.
  await adminPool.query(`DELETE FROM channel_connections WHERE id = $1`, [connectionId]);
  invalidateConnectionsCache();
  await adminPool.query(`DELETE FROM admin_permissions WHERE admin_id = $1`, [adminId]);
  await adminPool.query(`DELETE FROM admins WHERE id = $1`, [adminId]);
  await adminPool.query(`DELETE FROM settings WHERE id = $1`, [settingsId]);
  await adminPool.end();
  await appPool.end();
});

async function nuevaCotizacion(): Promise<string> {
  const quote = await generarCotizacion(conversationId, customerId, {
    items: [{ variant_id: variantId, quantity: 1 }],
  });
  return quote.quote_id;
}

describe("preguntar_metodo_pago", () => {
  it("manda la plantilla metodo_pago con nombre y total", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.metodo1" }] }));
    const quoteId = await nuevaCotizacion();

    const result = await preguntarMetodoPago({ quote_id: quoteId });

    expect(result).toEqual({ quote_id: quoteId, status: "enviado" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.template.name).toBe("metodo_pago");
    expect(payload.template.components[0].parameters).toHaveLength(2);
  });

  it("cotización inexistente devuelve status claro sin llamar a Meta", async () => {
    const result = await preguntarMetodoPago({ quote_id: "00000000-0000-0000-0000-000000000000" });
    expect(result).toEqual({
      quote_id: "00000000-0000-0000-0000-000000000000",
      status: "cotizacion_no_encontrada",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pedir_confirmacion_domicilio con confirmar_domicilio_pedido", () => {
  it("manda confirmar_domicilio sola primero; recién al confirmar la dirección se manda pedido_confirmado_v3", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.domicilio" }] }));

    const quoteId = await nuevaCotizacion();
    const created = await crearPedido(
      `sid-flujo-plantillas-${Date.now()}`,
      {
        quote_id: quoteId,
        payment_method: "efectivo_contraentrega",
        delivery_method: "domicilio",
        customer_data: customerData,
      },
      1000000,
    );
    expect(created.status).toBe("confirmed");
    const orderId = created.order_id!;

    // pedido_confirmado_v3 no está aprobada en este archivo (solo se probó
    // en el otro describe de admin.test.ts) — se aprueba acá para que el
    // segundo paso (confirmar_domicilio_pedido) la pueda mandar. El nombre
    // "_v3" es porque Meta bloqueó "pedido_confirmado" y "_v2" al borrarlas
    // (ver enviarPedidoConfirmado.ts).
    await crearPlantillaAprobada("pedido_confirmado_v3", [
      { type: "BODY", text: "Hola {{1}}, tu pedido #{{2}} por {{3}} fue confirmado. Método de entrega: {{4}}." },
    ]);

    const pedido = await pedirConfirmacionDomicilio({ order_id: orderId });
    expect(pedido).toEqual({ order_id: orderId, status: "enviado" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, initDomicilio] = fetchMock.mock.calls[0]!;
    const payloadDomicilio = JSON.parse((initDomicilio as RequestInit).body as string);
    expect(payloadDomicilio.template.name).toBe("confirmar_domicilio");

    // registrarGuia rechaza mientras no esté confirmado.
    const guiaAntes = await registrarGuia(orderId, { trackingNumber: "GUIA-FLUJO-1", carrier: "Servientrega" });
    expect(guiaAntes.ok).toBe(false);

    // El tap de "Confirmar dirección" llega como texto normal → tool. Esto
    // manda, recién ahora, el resumen "pedido_confirmado_v3".
    fetchMock.mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.pedidoconf" }] }));
    const confirmacion = await confirmarDomicilioPedido({ order_id: orderId });
    expect(confirmacion).toEqual({ order_id: orderId, status: "confirmado", pedido_confirmado_status: "enviado" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, initPedido] = fetchMock.mock.calls[1]!;
    const payloadPedido = JSON.parse((initPedido as RequestInit).body as string);
    expect(payloadPedido.template.name).toBe("pedido_confirmado_v3");

    // Un segundo tap a "Confirmar dirección" no vuelve a mandar el resumen
    // (idempotencia: AND address_confirmed_at IS NULL en el UPDATE).
    const segundaConfirmacion = await confirmarDomicilioPedido({ order_id: orderId });
    expect(segundaConfirmacion).toEqual({ order_id: orderId, status: "pedido_no_abierto" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Ahora sí se puede despachar.
    fetchMock.mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.encamino" }] }));
    const guiaDespues = await registrarGuia(orderId, { trackingNumber: "GUIA-FLUJO-1", carrier: "Servientrega" });
    expect(guiaDespues).toEqual({ ok: true });
  });
});

describe("agregar_item_pedido reenvía pedido_confirmado_v3 automáticamente", () => {
  it("al agregar un producto, manda sola la plantilla con el total actualizado (sin preguntar por texto)", async () => {
    const quoteId = await nuevaCotizacion();
    const created = await crearPedido(
      `sid-agregar-flujo-${Date.now()}`,
      {
        quote_id: quoteId,
        payment_method: "efectivo_contraentrega",
        delivery_method: "domicilio",
        customer_data: customerData,
      },
      1000000,
    );
    expect(created.status).toBe("confirmed");
    const orderId = created.order_id!;

    // Este describe corre después del de "confirmar_domicilio_pedido" (ver
    // arriba), que ya dejó "pedido_confirmado_v3" aprobada — mismo criterio
    // de orden que el resto del archivo.
    fetchMock.mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.agregaritem-flujo" }] }));
    const resultado = await agregarItemPedido(
      `sid-agregar-flujo-lote-${Date.now()}`,
      { order_id: orderId, items: [{ variant_id: variantId, quantity: 1 }] },
      1000000,
    );

    expect(resultado.status).toBe("actualizado");
    expect(resultado.total).toBe(created.total * 2);
    expect(resultado.pedido_confirmado_status).toBe("enviado");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.template.name).toBe("pedido_confirmado_v3");
    expect(payload.template.components[0].parameters[2]).toEqual({
      type: "text",
      text: `$${(created.total * 2).toLocaleString("es-CO")}`,
    });
  });
});

describe("actualizar_direccion_pedido", () => {
  async function nuevoPedidoAbierto(): Promise<string> {
    const quoteId = await nuevaCotizacion();
    const created = await crearPedido(
      `sid-flujo-direccion-${Date.now()}-${Math.random()}`,
      {
        quote_id: quoteId,
        payment_method: "efectivo_contraentrega",
        delivery_method: "domicilio",
        customer_data: customerData,
      },
      1000000,
    );
    return created.order_id!;
  }

  it("cambia la dirección del pedido sin tocar el perfil cuando guardar_permanente es false", async () => {
    const orderId = await nuevoPedidoAbierto();

    // pedido_confirmado_v3 ya quedó aprobada por el describe anterior — acá
    // solo hace falta el fetchMock para el envío automático del resumen.
    fetchMock.mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.pedidoconf-temporal" }] }));
    const result = await actualizarDireccionPedido({
      order_id: orderId,
      direccion_nueva: "Calle nueva temporal # 1-23",
      guardar_permanente: false,
    });
    expect(result).toEqual({ order_id: orderId, status: "actualizado", pedido_confirmado_status: "enviado" });

    const order = await adminPool.query<{ delivery_address: string; address_confirmed_at: Date | null }>(
      `SELECT delivery_address, address_confirmed_at FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0]!.delivery_address).toBe("Calle nueva temporal # 1-23");
    expect(order.rows[0]!.address_confirmed_at).not.toBeNull();

    const customer = await adminPool.query<{ address: string | null }>(`SELECT address FROM customers WHERE id = $1`, [
      customerId,
    ]);
    // customerData usa save_permanently: false — crearPedido nunca escribe en
    // customers.address con ese flag, así que sigue en null (el customer se
    // creó con un INSERT mínimo en el beforeAll de este archivo).
    expect(customer.rows[0]!.address).toBeNull();
  });

  it("además actualiza el perfil del cliente cuando guardar_permanente es true", async () => {
    const orderId = await nuevoPedidoAbierto();

    fetchMock.mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.pedidoconf-permanente" }] }));
    const result = await actualizarDireccionPedido({
      order_id: orderId,
      direccion_nueva: "Calle nueva permanente # 4-56",
      guardar_permanente: true,
    });
    expect(result).toEqual({ order_id: orderId, status: "actualizado", pedido_confirmado_status: "enviado" });

    const customer = await adminPool.query<{ address: string | null }>(`SELECT address FROM customers WHERE id = $1`, [
      customerId,
    ]);
    expect(customer.rows[0]!.address).toBe("Calle nueva permanente # 4-56");
  });

  it("devuelve pedido_no_abierto si el pedido ya no está abierto, sin tocar la dirección", async () => {
    const orderId = await nuevoPedidoAbierto();
    fetchMock.mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.cancelado-direccion" }] }));
    await cancelarPedido({ order_id: orderId });

    const before = await adminPool.query<{ delivery_address: string | null }>(
      `SELECT delivery_address FROM orders WHERE id = $1`,
      [orderId],
    );

    const result = await actualizarDireccionPedido({
      order_id: orderId,
      direccion_nueva: "Dirección que no debería guardarse",
      guardar_permanente: false,
    });
    expect(result).toEqual({ order_id: orderId, status: "pedido_no_abierto" });

    const after = await adminPool.query<{ delivery_address: string | null }>(
      `SELECT delivery_address FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(after.rows[0]!.delivery_address).toBe(before.rows[0]!.delivery_address);
  });
});

describe("confirmar_pago_pedido", () => {
  // `transfer_accounts` es un singleton compartido con todo el resto de la
  // app (settingsDirectory.ts) — no se restaura al valor "original" porque
  // puede venir sucio de otra corrida (ver
  // docs/gotchas del entorno local); se deja en `[]` a propósito, que es lo
  // que el resto de este archivo (describe "notificaciones de pago al
  // cliente") ya asume sin configurar nada.
  afterAll(async () => {
    await saveTransferAccounts([]);
  });

  async function nuevoPedido(paymentMethod: "transferencia" | "efectivo_contraentrega"): Promise<string> {
    const quoteId = await nuevaCotizacion();
    const created = await crearPedido(
      `sid-confirmar-pago-${Date.now()}-${Math.random()}`,
      {
        quote_id: quoteId,
        payment_method: paymentMethod,
        delivery_method: "domicilio",
        customer_data: customerData,
      },
      1000000,
    );
    return created.order_id!;
  }

  it("transferencia con cuentas configuradas manda los datos y devuelve datos_transferencia_enviados", async () => {
    await saveTransferAccounts([
      {
        entity: "Bancolombia",
        accountType: "Ahorros",
        accountNumber: "123456789",
        holderName: "ForMotos SAS",
        holderDocument: "",
        active: true,
      },
    ]);
    // crear_pedido con "transferencia" ya NO manda los datos automáticamente
    // (ver decisión del 2026-09-08: confirmar el pedido y confirmar el pago
    // son dos momentos distintos) — el único envío de este test es el de
    // confirmar_pago_pedido, resolviendo el botón "Confirmar y pagar".
    fetchMock.mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.transferencia-reenvio" }] }));
    const orderId = await nuevoPedido("transferencia");

    const result = await confirmarPagoPedido({ order_id: orderId });
    expect(result).toEqual({ order_id: orderId, status: "datos_transferencia_enviados" });
  });

  it("transferencia sin cuentas configuradas devuelve sin_cuentas_configuradas", async () => {
    await saveTransferAccounts([]);
    const orderId = await nuevoPedido("transferencia");

    const result = await confirmarPagoPedido({ order_id: orderId });
    expect(result).toEqual({ order_id: orderId, status: "sin_cuentas_configuradas" });
  });

  it("pago_en_linea con link guardado devuelve link_pago_disponible", async () => {
    // Wompi no está configurado en este fixture (ver describe "notificaciones
    // de pago al cliente" más abajo) — se crea con transferencia (que sí
    // queda 'confirmed') y se fuerza el estado de un pedido pago_en_linea a
    // mano, mismo criterio que el resto del archivo.
    const orderId = await nuevoPedido("transferencia");
    await adminPool.query(
      `UPDATE orders SET payment_method = 'pago_en_linea', payment_status = 'pendiente', wompi_payment_link_url = $2 WHERE id = $1`,
      [orderId, "https://checkout.wompi.co/l/test123"],
    );

    const result = await confirmarPagoPedido({ order_id: orderId });
    expect(result).toEqual({
      order_id: orderId,
      status: "link_pago_disponible",
      payment_link_url: "https://checkout.wompi.co/l/test123",
    });
  });

  it("pago_en_linea ya aprobado devuelve ya_pagado", async () => {
    const orderId = await nuevoPedido("transferencia");
    await adminPool.query(
      `UPDATE orders SET payment_method = 'pago_en_linea', payment_status = 'pagado', wompi_payment_link_url = $2 WHERE id = $1`,
      [orderId, "https://checkout.wompi.co/l/test456"],
    );

    const result = await confirmarPagoPedido({ order_id: orderId });
    expect(result).toEqual({ order_id: orderId, status: "ya_pagado" });
  });

  it("pago_en_linea sin link guardado devuelve sin_link_pago", async () => {
    const orderId = await nuevoPedido("transferencia");
    await adminPool.query(
      `UPDATE orders SET payment_method = 'pago_en_linea', payment_status = 'pendiente', wompi_payment_link_url = NULL WHERE id = $1`,
      [orderId],
    );

    const result = await confirmarPagoPedido({ order_id: orderId });
    expect(result).toEqual({ order_id: orderId, status: "sin_link_pago" });
  });

  it("efectivo contra entrega devuelve sin_pago_pendiente", async () => {
    const orderId = await nuevoPedido("efectivo_contraentrega");

    const result = await confirmarPagoPedido({ order_id: orderId });
    expect(result).toEqual({ order_id: orderId, status: "sin_pago_pendiente" });
  });

  it("pedido cancelado devuelve pedido_no_abierto", async () => {
    const orderId = await nuevoPedido("efectivo_contraentrega");
    fetchMock.mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.cancelado-pago" }] }));
    await cancelarPedido({ order_id: orderId });

    const result = await confirmarPagoPedido({ order_id: orderId });
    expect(result).toEqual({ order_id: orderId, status: "pedido_no_abierto" });
  });

  it("pedido ya despachado también devuelve pedido_no_abierto (no solo cancelado/expirado)", async () => {
    const orderId = await nuevoPedido("transferencia");
    await adminPool.query(`UPDATE orders SET status = 'despachado' WHERE id = $1`, [orderId]);

    const result = await confirmarPagoPedido({ order_id: orderId });
    expect(result).toEqual({ order_id: orderId, status: "pedido_no_abierto" });
  });

  it("pago_en_linea rechazado devuelve pago_rechazado, sin reenviar el link viejo", async () => {
    const orderId = await nuevoPedido("transferencia");
    await adminPool.query(
      `UPDATE orders SET payment_method = 'pago_en_linea', payment_status = 'rechazado', wompi_payment_link_url = $2 WHERE id = $1`,
      [orderId, "https://checkout.wompi.co/l/test-rechazado"],
    );

    const result = await confirmarPagoPedido({ order_id: orderId });
    expect(result).toEqual({ order_id: orderId, status: "pago_rechazado" });
  });

  it("transferencia con cuentas configuradas pero el envío falla devuelve error_envio_transferencia", async () => {
    await saveTransferAccounts([
      {
        entity: "Bancolombia",
        accountType: "Ahorros",
        accountNumber: "123456789",
        holderName: "ForMotos SAS",
        holderDocument: "",
        active: true,
      },
    ]);
    // crear_pedido ya no manda nada automático (ver arriba) — el único
    // intento de envío es el de confirmar_pago_pedido, y ese es el que
    // falla acá, para comprobar que no se confunde con "sin cuentas
    // configuradas".
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const orderId = await nuevoPedido("transferencia");

    const result = await confirmarPagoPedido({ order_id: orderId });
    expect(result).toEqual({ order_id: orderId, status: "error_envio_transferencia" });
  });

  it("pedido inexistente devuelve pedido_no_encontrado", async () => {
    const result = await confirmarPagoPedido({ order_id: "00000000-0000-0000-0000-000000000000" });
    expect(result).toEqual({ order_id: "00000000-0000-0000-0000-000000000000", status: "pedido_no_encontrado" });
  });
});

describe("notificaciones de pago al cliente", () => {
  async function nuevoPedidoConfirmado(paymentMethod: "pago_en_linea" | "transferencia" = "pago_en_linea") {
    const quoteId = await nuevaCotizacion();
    const created = await crearPedido(
      `sid-flujo-pago-${Date.now()}-${Math.random()}`,
      {
        quote_id: quoteId,
        payment_method: paymentMethod,
        delivery_method: "recoger_en_tienda",
        customer_data: customerData,
      },
      1000000,
    );
    return created.order_id!;
  }

  it("marcarPagoAprobado + notificarClientePagoAprobado manda pago_aprobado con el botón de reseña", async () => {
    // Wompi no configurado en este fixture → crearPedido con pago_en_linea
    // devuelve wompi_no_configurado y no llega a "confirmed". Se crea con
    // transferencia (que sí queda 'confirmed') y se fuerza payment_status
    // de vuelta a 'pendiente' para simular el estado real que tendría un
    // pedido pago_en_linea recién creado, sin depender de Wompi — el
    // escenario real del webhook ya se cubre en wompiWebhook.test.ts; acá
    // el foco es la notificación al cliente, no la fuente del estado.
    const orderId = await nuevoPedidoConfirmado("transferencia");
    await adminPool.query(`UPDATE orders SET payment_status = 'pendiente' WHERE id = $1`, [orderId]);

    const total = await marcarPagoAprobado(orderId, `tx-flujo-${Date.now()}`);
    expect(total).not.toBeNull();

    fetchMock.mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.pagoaprobado" }] }));
    await notificarClientePagoAprobado(orderId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.template.name).toBe("pago_aprobado");
    const boton = payload.template.components.find((c: { type: string }) => c.type === "button");
    expect(boton.parameters[0].text).toMatch(/^[A-Za-z0-9_-]+$/); // token de reseña
  });

  it("marcarPagoRechazado + notificarClientePagoRechazado manda pago_rechazado", async () => {
    const orderId = await nuevoPedidoConfirmado("transferencia");
    await adminPool.query(`UPDATE orders SET payment_status = 'pendiente' WHERE id = $1`, [orderId]);

    const aplicado = await marcarPagoRechazado(orderId, "Wompi reportó DECLINED (test).");
    expect(aplicado).toBe(true);

    fetchMock.mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.pagorechazado" }] }));
    await notificarClientePagoRechazado(orderId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.template.name).toBe("pago_rechazado");
  });
});

describe("cancelar_pedido manda pedido_cancelado", () => {
  it("cancela el pedido y notifica con la plantilla", async () => {
    const quoteId = await nuevaCotizacion();
    const created = await crearPedido(
      `sid-flujo-cancelar-${Date.now()}`,
      {
        quote_id: quoteId,
        payment_method: "efectivo_contraentrega",
        delivery_method: "recoger_en_tienda",
        customer_data: customerData,
      },
      1000000,
    );
    const orderId = created.order_id!;

    fetchMock.mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.cancelado" }] }));
    const result = await cancelarPedido({ order_id: orderId });

    expect(result.status).toBe("cancelado");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.template.name).toBe("pedido_cancelado");
  });
});
