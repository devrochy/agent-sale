import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAdmin } from "../../../src/admin/auth/adminsDirectory.js";
import { hashPassword } from "../../../src/admin/auth/passwordHash.js";
import { cerrarPedido } from "../../../src/domains/commerce/cerrarPedido.js";
import { cancelarPedido } from "../../../src/domains/commerce/cancelarPedido.js";
import { confirmarDomicilioPedido } from "../../../src/domains/commerce/confirmarDomicilioPedido.js";
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
 * por el panel: preguntar_metodo_pago, cerrar_pedido (con el segundo envío
 * de confirmar_domicilio), confirmar_domicilio_pedido, el gate de
 * registrarGuia, y las notificaciones de pago aprobado/rechazado y pedido
 * cancelado. Mismo criterio de mock de `fetch` que
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

describe("cerrar_pedido con confirmar_domicilio", () => {
  it("manda pedido_confirmado y confirmar_domicilio, y confirmar_domicilio_pedido cierra el ciclo", async () => {
    fetchMock
      .mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.pedidoconf" }] }))
      .mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.domicilio" }] }));

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

    // pedido_confirmado no está aprobada en este archivo (solo se probó en
    // el otro describe de admin.test.ts) — acá el foco es
    // confirmar_domicilio, así que se aprueba también pedido_confirmado
    // para no ensuciar el resultado con "plantilla_no_aprobada".
    await crearPlantillaAprobada("pedido_confirmado", [
      { type: "BODY", text: "Hola {{1}}, tu pedido #{{2}} por {{3}} fue confirmado. Método de entrega: {{4}}." },
    ]);

    const cierre = await cerrarPedido({ order_id: orderId });
    expect(cierre.status).toBe("enviado");
    expect(cierre.domicilio_status).toBe("enviado");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, initDomicilio] = fetchMock.mock.calls[1]!;
    const payloadDomicilio = JSON.parse((initDomicilio as RequestInit).body as string);
    expect(payloadDomicilio.template.name).toBe("confirmar_domicilio");

    // registrarGuia rechaza mientras no esté confirmado.
    const guiaAntes = await registrarGuia(orderId, { trackingNumber: "GUIA-FLUJO-1", carrier: "Servientrega" });
    expect(guiaAntes.ok).toBe(false);

    // El tap de "Confirmar dirección" llega como texto normal → tool.
    const confirmacion = await confirmarDomicilioPedido({ order_id: orderId });
    expect(confirmacion).toEqual({ order_id: orderId, status: "confirmado" });

    // Ahora sí se puede despachar.
    fetchMock.mockResolvedValueOnce(okJsonResponse({ messages: [{ id: "wamid.encamino" }] }));
    const guiaDespues = await registrarGuia(orderId, { trackingNumber: "GUIA-FLUJO-1", carrier: "Servientrega" });
    expect(guiaDespues).toEqual({ ok: true });
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
