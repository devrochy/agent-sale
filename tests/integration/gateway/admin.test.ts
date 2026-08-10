import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// El adapter de salida se controla desde el test: "Probar y guardar" llama a
// verifyCredentials, y sin este mock el test haría una llamada HTTP real a
// Twilio. El comportamiento del adapter en sí está cubierto en
// tests/unit/gateway/channels/twilio/outbound.test.ts.
const verifyCredentials = vi.fn();
vi.mock("../../../src/gateway/channels/registry.js", () => ({
  outboundAdapterFor: (provider: string) => ({ provider, deliveryModel: "poll", verifyCredentials }),
  inboundAdapterFor: () => {
    throw new Error("no usado en este test");
  },
  inboundProviders: () => ["twilio"],
}));

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendToConversation: vi.fn(),
  getWhatsAppMessageStatus: vi.fn(),
}));

import { createAdmin } from "../../../src/admin/auth/adminsDirectory.js";
import { hashPassword } from "../../../src/admin/auth/passwordHash.js";
import { buildServer } from "../../../src/gateway/server.js";
import { sendToConversation } from "../../../src/gateway/sendMessage.js";
import {
  invalidateConnectionsCache,
  saveConnection,
} from "../../../src/shared/db/connectionsDirectory.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { deleteProduct, seedProduct } from "../../helpers/seedCatalog.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const ADMIN_USERNAME = "colaboradora-master";
const ADMIN_EMAIL = "colaboradora@formotos-test.com";
const ADMIN_PASSWORD = "clave-de-prueba-segura";

/** Extrae "nombre=valor" del header Set-Cookie, descartando Path/HttpOnly/etc, para reusar en el header Cookie de los requests siguientes. */
function cookieValueFrom(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) {
    throw new Error("Respuesta de login sin Set-Cookie");
  }
  return raw.split(";")[0]!;
}

let settingsId: string;
// `settings` es un singleton sin constraint que lo obligue en la base de
// datos (ver settingsDirectory.ts) — en la DB de desarrollo persistente ya
// puede existir una fila real (config manual del negocio). Insertar una
// segunda rompería getSettings()'s `LIMIT 1` sin ORDER BY, que puede
// devolver cualquiera de las dos. Por eso se reusa la fila existente si la
// hay, guardando sus valores para restaurarlos en el afterAll.
let settingsCreated = false;
let previousSettingsName: string;
let previousSettingsDisplayName: string | null;
let productId: string;
let agentId: string;
let conversacionAbierta: string;
let conversacionEscalada: string;
let conversacionCerrada: string;
let sessionCookie: string;
const customerIds: string[] = [];
const conversationIds: string[] = [];
// Colaboradores creados a lo largo del describe "colaboradores" — el
// master de beforeAll más los que crean los tests vía POST /admin/colaboradores
// (los que fallan validación, ej. "clave-corta@...", nunca llegan a existir).
const adminEmails = [
  ADMIN_EMAIL,
  "nuevo.colaborador@formotos-test.com",
  "sesion-expirada@formotos-test.com",
  "para-desactivar@formotos-test.com",
  "con-permisos@formotos-test.com",
  "colab-conexiones@formotos.test",
];
const app = await buildServer();

beforeAll(async () => {
  const existing = await adminPool.query<{ id: string; name: string; display_name: string | null }>(
    `SELECT id, name, display_name FROM settings LIMIT 1`,
  );
  if (existing.rows[0]) {
    settingsId = existing.rows[0].id;
    previousSettingsName = existing.rows[0].name;
    previousSettingsDisplayName = existing.rows[0].display_name;
    await adminPool.query(`UPDATE settings SET name = 'Admin Panel Test', display_name = NULL WHERE id = $1`, [
      settingsId,
    ]);
  } else {
    settingsCreated = true;
    previousSettingsName = "Admin Panel Test";
    previousSettingsDisplayName = null;
    const settings = await adminPool.query<{ id: string }>(
      `INSERT INTO settings (name) VALUES ('Admin Panel Test') RETURNING id`,
    );
    settingsId = settings.rows[0]!.id;
  }

  const product = await seedProduct(adminPool, {
    sku: "ADMIN-A",
    name: "Casco Panel A",
    price: 250000,
    stock: 5,
  });
  productId = product.productId;
  await adminPool.query(
    `UPDATE products SET description = $1, image_url = $2 WHERE id = $3`,
    ["Casco de prueba del panel A", "https://picsum.photos/seed/ADMIN-A/600/400", productId],
  );

  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (phone_number, name) VALUES ('whatsapp:+573000000000', 'Cliente Overview') RETURNING id`,
  );
  customerIds.push(customer.rows[0]!.id);
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customer.rows[0]!.id],
  );
  conversacionAbierta = conversation.rows[0]!.id;
  conversationIds.push(conversacionAbierta);
  await adminPool.query(
    `INSERT INTO messages (conversation_id, direction, sender_type, content)
     VALUES ($1, 'inbound', 'customer', 'Hola, ¿tienen cascos?')`,
    [conversation.rows[0]!.id],
  );

  // Conversación escalada — inbox de Conversaciones (Fase 11.2): el
  // mensaje trae tool_calls para probar que la vista reusa el mismo
  // renderMessageBody() del inbox del asesor (handoffView.ts).
  const customerEscalado = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (phone_number, name) VALUES ('whatsapp:+573000000006', 'Cliente Escalado') RETURNING id`,
  );
  customerIds.push(customerEscalado.rows[0]!.id);
  const conversationEscalada = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerEscalado.rows[0]!.id],
  );
  conversacionEscalada = conversationEscalada.rows[0]!.id;
  conversationIds.push(conversacionEscalada);
  await adminPool.query(
    `INSERT INTO messages (conversation_id, direction, sender_type, content, tool_calls)
     VALUES ($1, 'outbound', 'agent', '', $2::jsonb)`,
    [
      conversationEscalada.rows[0]!.id,
      JSON.stringify([
        { type: "tool_use", name: "consultar_inventario", input: { query: "cascos" } },
      ]),
    ],
  );
  const agentPasswordHash = await hashPassword("clave-de-prueba-laura-velez");
  agentId = await createAdmin("Laura Vélez", "laura@formotos-test.com", agentPasswordHash, "colaborador", null);
  await adminPool.query(
    `INSERT INTO handoff_queue (conversation_id, reason, status, assigned_admin_id)
     VALUES ($1, 'solicitud_cliente', 'en_atencion', $2)`,
    [conversationEscalada.rows[0]!.id, agentId],
  );

  // Ticket de riesgo ("Vigilante", Fase 12.1) — reason 'queja' debe
  // resaltarse distinto de un escalamiento rutinario como el de arriba.
  const customerQueja = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (phone_number, name) VALUES ('whatsapp:+573000000005', 'Cliente Molesto') RETURNING id`,
  );
  customerIds.push(customerQueja.rows[0]!.id);
  const conversationQueja = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerQueja.rows[0]!.id],
  );
  conversationIds.push(conversationQueja.rows[0]!.id);
  await adminPool.query(
    `INSERT INTO messages (conversation_id, direction, sender_type, content)
     VALUES ($1, 'inbound', 'customer', 'Esto es un desastre, llevo dos semanas esperando')`,
    [conversationQueja.rows[0]!.id],
  );
  await adminPool.query(
    `INSERT INTO handoff_queue (conversation_id, reason, status)
     VALUES ($1, 'queja', 'queued')`,
    [conversationQueja.rows[0]!.id],
  );

  // Conversación cerrada — cubre el tab "Cerradas".
  const customerCerrado = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (phone_number) VALUES ('whatsapp:+573000000002') RETURNING id`,
  );
  customerIds.push(customerCerrado.rows[0]!.id);
  const conversationCerrada = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id, status, closed_at) VALUES ($1, 'closed', now()) RETURNING id`,
    [customerCerrado.rows[0]!.id],
  );
  conversacionCerrada = conversationCerrada.rows[0]!.id;
  conversationIds.push(conversacionCerrada);
  await adminPool.query(
    `INSERT INTO messages (conversation_id, direction, sender_type, content)
     VALUES ($1, 'inbound', 'customer', 'Gracias, ya no necesito nada más')`,
    [conversationCerrada.rows[0]!.id],
  );

  // Leads con cotización y con pedido — cubren las 4 categorías del
  // funnel de metricas-cierre-ventas.md que la vista de Leads reusa.
  const customerCotizacion = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (phone_number, name) VALUES ('whatsapp:+573000000003', 'Cliente Con Cotización') RETURNING id`,
  );
  customerIds.push(customerCotizacion.rows[0]!.id);
  const conversationCotizacion = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerCotizacion.rows[0]!.id],
  );
  conversationIds.push(conversationCotizacion.rows[0]!.id);
  await adminPool.query(
    `INSERT INTO messages (conversation_id, direction, sender_type, content)
     VALUES ($1, 'inbound', 'customer', 'Quiero cotizar un casco')`,
    [conversationCotizacion.rows[0]!.id],
  );
  // Regresión: el orquestador también guarda los tool_results como
  // inbound/agent con content vacío (ver loop.ts) — este mensaje, más
  // reciente que el del cliente, no debe ganarle al heurístico de
  // "último mensaje" de Leads.
  await adminPool.query(
    `INSERT INTO messages (conversation_id, direction, sender_type, content)
     VALUES ($1, 'inbound', 'agent', '')`,
    [conversationCotizacion.rows[0]!.id],
  );
  await adminPool.query(
    `INSERT INTO quotes (conversation_id, customer_id, subtotal, total)
     VALUES ($1, $2, 250000, 250000)`,
    [conversationCotizacion.rows[0]!.id, customerCotizacion.rows[0]!.id],
  );

  const customerPedido = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (phone_number, name) VALUES ('whatsapp:+573000000004', 'Cliente Con Pedido') RETURNING id`,
  );
  customerIds.push(customerPedido.rows[0]!.id);
  const conversationPedido = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerPedido.rows[0]!.id],
  );
  conversationIds.push(conversationPedido.rows[0]!.id);
  await adminPool.query(
    `INSERT INTO messages (conversation_id, direction, sender_type, content)
     VALUES ($1, 'inbound', 'customer', 'Confirmo el pedido')`,
    [conversationPedido.rows[0]!.id],
  );
  const quotePedido = await adminPool.query<{ id: string }>(
    `INSERT INTO quotes (conversation_id, customer_id, subtotal, total)
     VALUES ($1, $2, 250000, 250000) RETURNING id`,
    [conversationPedido.rows[0]!.id, customerPedido.rows[0]!.id],
  );
  await adminPool.query(
    `INSERT INTO orders (quote_id, conversation_id, customer_id, payment_method, delivery_method, idempotency_key, total)
     VALUES ($1, $2, $3, 'transferencia', 'domicilio', 'admin-test-order-1', 250000)`,
    [quotePedido.rows[0]!.id, conversationPedido.rows[0]!.id, customerPedido.rows[0]!.id],
  );

  // Admin real (Fase 13, ver ADR-025) para autenticar el resto de los
  // tests — role='master' para no depender de permisos granulares acá
  // (esos se prueban en tests/unit de src/admin/auth/).
  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  await createAdmin(ADMIN_USERNAME, ADMIN_EMAIL, passwordHash, "master", null);

  await app.ready();

  const loginResponse = await app.inject({
    method: "POST",
    url: "/login",
    payload: new URLSearchParams({ identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  sessionCookie = cookieValueFrom(loginResponse.headers["set-cookie"]);
});

afterAll(async () => {
  await adminPool.query(
    `DELETE FROM admin_sessions WHERE admin_id IN (SELECT id FROM admins WHERE email = ANY($1))`,
    [adminEmails],
  );
  await adminPool.query(
    `DELETE FROM admin_permissions WHERE admin_id IN (SELECT id FROM admins WHERE email = ANY($1))`,
    [adminEmails],
  );
  await adminPool.query(`DELETE FROM admins WHERE email = ANY($1)`, [adminEmails]);
  await adminPool.query(
    `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = ANY($1))`,
    [conversationIds],
  );
  await adminPool.query(`DELETE FROM orders WHERE conversation_id = ANY($1)`, [conversationIds]);
  await adminPool.query(
    `DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = ANY($1))`,
    [conversationIds],
  );
  await adminPool.query(`DELETE FROM quotes WHERE conversation_id = ANY($1)`, [conversationIds]);
  await adminPool.query(`DELETE FROM handoff_queue WHERE conversation_id = ANY($1)`, [
    conversationIds,
  ]);
  await adminPool.query(`DELETE FROM admin_permissions WHERE admin_id = $1`, [agentId]);
  await adminPool.query(`DELETE FROM admins WHERE id = $1`, [agentId]);
  await adminPool.query(`DELETE FROM messages WHERE conversation_id = ANY($1)`, [conversationIds]);
  await adminPool.query(`DELETE FROM conversations WHERE id = ANY($1)`, [conversationIds]);
  await adminPool.query(`DELETE FROM customers WHERE id = ANY($1)`, [customerIds]);
  await deleteProduct(adminPool, productId);
  if (settingsCreated) {
    await adminPool.query(`DELETE FROM settings WHERE id = $1`, [settingsId]);
  } else {
    await adminPool.query(`UPDATE settings SET name = $1, display_name = $2 WHERE id = $3`, [
      previousSettingsName,
      previousSettingsDisplayName,
      settingsId,
    ]);
  }
  await app.close();
  await adminPool.end();
  await appPool.end();
});

describe("panel admin", () => {
  it("redirige a /login sin sesión", async () => {
    const response = await app.inject({ method: "GET", url: "/admin" });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/login");
  });

  it("redirige a /login con una cookie de sesión inválida", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: "agent_sale_admin_session=token-que-no-existe" },
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/login");
  });

  it("login con contraseña incorrecta no autentica", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/login",
      payload: new URLSearchParams({ identifier: ADMIN_EMAIL, password: "clave-incorrecta" }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("Correo o contraseña incorrectos");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("login correcto autentica y logout invalida la sesión", async () => {
    const loginResponse = await app.inject({
      method: "POST",
      url: "/login",
      payload: new URLSearchParams({ identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(loginResponse.statusCode).toBe(303);
    expect(loginResponse.headers.location).toBe("/admin");
    const cookie = cookieValueFrom(loginResponse.headers["set-cookie"]);

    const overview = await app.inject({ method: "GET", url: "/admin", headers: { cookie } });
    expect(overview.statusCode).toBe(200);

    const logoutResponse = await app.inject({
      method: "POST",
      url: "/logout",
      headers: { cookie },
    });
    expect(logoutResponse.statusCode).toBe(303);
    expect(logoutResponse.headers.location).toBe("/login");

    const afterLogout = await app.inject({ method: "GET", url: "/admin", headers: { cookie } });
    expect(afterLogout.statusCode).toBe(303);
    expect(afterLogout.headers.location).toBe("/login");
  });

  it("muestra el catálogo con los productos existentes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin/productos",
      headers: { cookie: sessionCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Casco Panel A");
    expect(response.body).toContain("Casco de prueba del panel A");
  });

  it("muestra la página de pedidos", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin/pedidos",
      headers: { cookie: sessionCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Pedidos");
  });

  it("muestra el resumen con marca por default (name), KPIs y conversaciones recientes", async () => {
    const response = await app.inject({ method: "GET", url: "/admin", headers: { cookie: sessionCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Admin Panel Test");
    expect(response.body).toContain("Mensajes · 24 h");
    expect(response.body).toContain("Cliente Overview");
    expect(response.body).toContain("Hola, ¿tienen cascos?");

    // Regresión: pg parsea columnas `date` como objeto Date, no string —
    // si la query de actividad vuelve a comparar esa fecha contra un
    // string ISO, el mensaje sembrado en beforeAll (hoy) no cae en
    // ningún bucket y todos los días quedan en 0 pese a haber actividad.
    // El gráfico se construye del lado del cliente a partir de este JSON.
    const match = response.body.match(
      /<script type="application\/json" id="actividad-data">(.*?)<\/script>/s,
    );
    expect(match).not.toBeNull();
    const actividad = JSON.parse(match![1]!) as { label: string; valor: number }[];
    expect(actividad.some((dia) => dia.valor > 0)).toBe(true);
  });

  it("usa display_name como marca cuando se configura", async () => {
    await adminPool.query(`UPDATE settings SET display_name = 'Marca Personalizada' WHERE id = $1`, [
      settingsId,
    ]);
    const response = await app.inject({ method: "GET", url: "/admin", headers: { cookie: sessionCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Marca Personalizada");
    await adminPool.query(`UPDATE settings SET display_name = NULL WHERE id = $1`, [settingsId]);
  });

  describe("conversaciones", () => {
    it("sin filtro en la URL muestra por defecto las conversaciones abiertas, con el nombre real del cliente", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/conversaciones",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Cliente Overview");
      // Pedido explícito del usuario: Abiertas y Escaladas pasan a ser
      // mutuamente excluyentes — una conversación con ticket activo ya no
      // aparece en el filtro por defecto (Abiertas).
      expect(response.body).not.toContain("Cliente Escalado");
      // La conversación cerrada (whatsapp:+573000000002) tampoco aparece
      // por defecto — pedido explícito del usuario: Abiertas es el filtro
      // inicial, ya no Todas.
      expect(response.body).not.toContain("whatsapp:+573000000002");
    });

    it("el tab Todas sí incluye la conversación cerrada, con el fallback al teléfono cuando no hay nombre", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/conversaciones?estado=todas",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Cliente Overview");
      expect(response.body).toContain("Cliente Escalado");
      // Sin cliente sembrado como número puro (whatsapp:+573000000002)
      // cae al fallback de mostrar el teléfono.
      expect(response.body).toContain("whatsapp:+573000000002");
    });

    it("cada conversación de la lista muestra un chip de estado con su color propio (azul/rojo/verde)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/conversaciones?estado=todas",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<span class="chip chip--chrome">Abierta</span>');
      expect(response.body).toContain('<span class="chip chip--redline">Escalada</span>');
      expect(response.body).toContain('<span class="chip chip--go">Cerrada</span>');
    });

    it("el detalle de una conversación escalada muestra el estado del ticket, quién lo tomó y el botón para ver el ticket", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/conversaciones?estado=escaladas&c=${conversacionEscalada}`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("En atención");
      expect(response.body).toContain("Tomó: Laura Vélez");
      expect(response.body).toContain('aria-label="Ver ticket"');
    });

    it("el tab Escaladas solo muestra conversaciones con handoff abierto", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/conversaciones?estado=escaladas",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Cliente Escalado");
      expect(response.body).not.toContain("Cliente Overview");
    });

    it("el tab Cerradas solo muestra conversaciones cerradas", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/conversaciones?estado=cerradas",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("whatsapp:+573000000002");
      expect(response.body).not.toContain("Cliente Overview");
    });

    it("muestra el historial completo de una conversación seleccionada, incluida la tool ejecutada", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/conversaciones?c=${conversacionAbierta}`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Hola, ¿tienen cascos?");
    });

    it("muestra qué tool se ejecutó cuando el mensaje trae tool_calls", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/conversaciones?c=${conversacionEscalada}`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("tool: consultar_inventario");
    });

    it("marca la conversación cerrada como tal en el detalle", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/conversaciones?estado=cerradas&c=${conversacionCerrada}`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Gracias, ya no necesito nada más");
      expect(response.body).toContain("cerrada");
    });
  });

  describe("leads", () => {
    it("clasifica cada cliente en su estado real del funnel comercial", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/leads",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Cliente Overview");
      expect(response.body).toContain("Sin actividad");
      expect(response.body).toContain("Cliente Escalado");
      expect(response.body).toContain("Escalada");
      expect(response.body).toContain("Cliente Con Cotización");
      expect(response.body).toContain("Con cotización");
      expect(response.body).toContain("Cliente Con Pedido");
      expect(response.body).toContain("Con pedido");
    });

    it("agrega columna de clasificación, toggle de bot, pedidos/última compra/ciudad y accesos a promoción/detalle por fila (Fase 23, ver ADR-036)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/leads",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Clasificación");
      expect(response.body).toContain("<th>Bot</th>");
      expect(response.body).toContain("<th>Pedidos</th>");
      expect(response.body).toContain("Última compra");
      expect(response.body).toContain("<th>Ciudad</th>");
      expect(response.body).toContain("Crear promoción para este segmento");
      expect(response.body).toContain("Ver información del cliente");
      expect(response.body).not.toContain("<th>Último mensaje</th>");
    });

    it("el último mensaje ignora los tool_results vacíos y muestra el texto real del cliente en el CSV (Fase 23: la tabla en pantalla ya no muestra esta columna, ver ADR-036)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/leads.csv",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Quiero cotizar un casco");
    });

    it("exporta el mismo listado como CSV descargable", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/leads.csv",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/csv");
      expect(response.headers["content-disposition"]).toContain("leads.csv");
      expect(response.body).toContain(
        "nombre,telefono,ultimo_mensaje,estado,clasificacion,pedidos,ultima_compra,ciudad,cliente_desde",
      );
      expect(response.body).toContain("Cliente Con Pedido");
      // Regresión: pg parsea timestamptz como objeto Date, no string — un
      // .toString() implícito al armar el CSV a mano produce
      // "Wed Jul 29 2026 03:09:20 GMT-0500 (...)" en vez de una fecha ISO.
      expect(response.body).not.toContain("GMT");
      expect(response.body).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe("tickets", () => {
    it("lista los casos escalados con motivo, estado y asesor asignado", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/tickets",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Cliente Escalado");
      expect(response.body).toContain("Solicitud del cliente");
      expect(response.body).toContain("En atención");
      expect(response.body).toContain("Laura Vélez");
    });

    it('marca los tickets de riesgo ("Vigilante": queja o monto alto) distinto de un escalamiento rutinario', async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/tickets",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatch(/chip chip--redline"[^>]*>⚠ Queja/);
      // El escalamiento rutinario (solicitud_cliente) no lleva el marcador de riesgo.
      expect(response.body).not.toMatch(/⚠ Solicitud del cliente/);
    });

    it("enlaza cada ticket a su conversación en el inbox mediante un botón icono", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/tickets",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(
        `/admin/conversaciones?estado=escaladas&c=${conversacionEscalada}`,
      );
      expect(response.body).toContain('aria-label="Ver conversación"');
      expect(response.body).not.toContain("Ver conversación →");
    });

    it("agrega filtros por estado y motivo, y encabezados ordenables por columna", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/tickets",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('data-filter-key="estado"');
      expect(response.body).toContain('data-filter-key="motivo"');
      expect(response.body).toContain('data-sort-key="cliente"');
      expect(response.body).toContain('data-sort-key="estado"');
      expect(response.body).toContain('data-sort-key="asignado"');
      expect(response.body).toContain('data-sort-key="creado"');
    });

    it("muestra el botón de tomar para un ticket en cola, y de resolver/reasignar para uno en atención", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/tickets",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('aria-label="Tomar ticket"');
      expect(response.body).toContain('aria-label="Marcar como resuelto"');
      expect(response.body).toContain('aria-label="Reasignar al asistente"');
    });
  });

  describe("tickets desde conversaciones (Fase 18, ADR-028)", () => {
    let customerId: string;
    let conversationId: string;
    let handoffId: string;

    beforeAll(async () => {
      const customer = await adminPool.query<{ id: string }>(
        `INSERT INTO customers (phone_number, name) VALUES ('whatsapp:+573000000007', 'Cliente Fase 18') RETURNING id`,
      );
      customerId = customer.rows[0]!.id;
      const conversation = await adminPool.query<{ id: string }>(
        `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
        [customerId],
      );
      conversationId = conversation.rows[0]!.id;
      await adminPool.query(
        `INSERT INTO messages (conversation_id, direction, sender_type, content)
         VALUES ($1, 'inbound', 'customer', 'Necesito hablar con alguien')`,
        [conversationId],
      );
      const handoff = await adminPool.query<{ id: string }>(
        `INSERT INTO handoff_queue (conversation_id, reason, status, summary)
         VALUES ($1, 'solicitud_cliente', 'queued', 'Cliente pide un humano')
         RETURNING id`,
        [conversationId],
      );
      handoffId = handoff.rows[0]!.id;
    });

    afterAll(async () => {
      await adminPool.query(`DELETE FROM handoff_tokens WHERE handoff_id = $1`, [handoffId]);
      await adminPool.query(`DELETE FROM handoff_queue WHERE id = $1`, [handoffId]);
      await adminPool.query(`DELETE FROM messages WHERE conversation_id = $1`, [conversationId]);
      await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
      await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
    });

    it("el detalle de una conversación con ticket en cola muestra el botón de tomar, sin JSON crudo del estado", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/conversaciones?estado=escaladas&c=${conversationId}`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Tomar ticket");
      // El layout comparte JS de columnas/CSV que sí usa JSON.stringify
      // (adminPanel.ts) — lo que no debe pasar es que el estado del flujo
      // comercial (`conversations.state`) se sirva serializado tal cual
      // dentro del detalle. Ver ADR-028 / DoD #2.
      const threadSection = response.body.match(
        /<div class="thread__head">[\s\S]*?<div class="thread__body">[\s\S]*?<\/div>/,
      )?.[0];
      expect(threadSection).toBeTruthy();
      expect(threadSection).not.toContain("JSON.stringify");
    });

    it("tomar el ticket lo pasa a en_atencion, lo asigna al admin de la sesión, pausa el bot de esa conversación y avisa al cliente por WhatsApp", async () => {
      vi.mocked(sendToConversation).mockClear();
      const response = await app.inject({
        method: "POST",
        url: `/admin/conversaciones/${handoffId}/tomar`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain(`c=${conversationId}`);

      const row = await adminPool.query<{ status: string; assigned_admin_id: string | null }>(
        `SELECT status, assigned_admin_id FROM handoff_queue WHERE id = $1`,
        [handoffId],
      );
      expect(row.rows[0]!.status).toBe("en_atencion");
      expect(row.rows[0]!.assigned_admin_id).toBeTruthy();

      // El bot de esta conversación puntual queda pausado al tomar el
      // ticket — antes seguía respondiéndole al cliente aunque un humano
      // ya lo estuviera atendiendo.
      const conversation = await adminPool.query<{ bot_paused: boolean }>(
        `SELECT bot_paused FROM conversations WHERE id = $1`,
        [conversationId],
      );
      expect(conversation.rows[0]!.bot_paused).toBe(true);

      expect(sendToConversation).toHaveBeenCalledWith(
        conversationId,
        expect.stringContaining(ADMIN_USERNAME),
      );
    });

    it("con el ticket en atención, el detalle bloquea el toggle del bot, ofrece reasignar al asistente y muestra el composer para responder", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/conversaciones?estado=escaladas&c=${conversationId}`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("toggleswitch--locked");
      expect(response.body).toContain("Reasignar al asistente");
      expect(response.body).toContain(`action="/admin/conversaciones/${conversationId}/mensaje"`);
    });

    it("enviar un mensaje desde el composer lo manda por WhatsApp y lo guarda como sender_type human", async () => {
      vi.mocked(sendToConversation).mockClear();
      const response = await app.inject({
        method: "POST",
        url: `/admin/conversaciones/${conversationId}/mensaje`,
        headers: { cookie: sessionCookie },
        payload: { mensaje: "Ya reviso tu caso, dame un momento." },
      });
      expect(response.statusCode).toBe(303);

      expect(sendToConversation).toHaveBeenCalledWith(
        conversationId,
        "Ya reviso tu caso, dame un momento.",
      );

      const message = await adminPool.query<{ direction: string; sender_type: string; content: string }>(
        `SELECT direction, sender_type, content FROM messages
         WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [conversationId],
      );
      expect(message.rows[0]).toMatchObject({
        direction: "outbound",
        sender_type: "human",
        content: "Ya reviso tu caso, dame un momento.",
      });
    });

    it("resolver el ticket lo cierra, cierra la conversación y notifica al cliente por WhatsApp quién lo atendió", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/admin/conversaciones/${handoffId}/resolver`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(303);

      const row = await adminPool.query<{ status: string; resolved_at: string | null }>(
        `SELECT status, resolved_at FROM handoff_queue WHERE id = $1`,
        [handoffId],
      );
      expect(row.rows[0]!.status).toBe("resuelto");
      expect(row.rows[0]!.resolved_at).not.toBeNull();

      const conversation = await adminPool.query<{ status: string }>(
        `SELECT status FROM conversations WHERE id = $1`,
        [conversationId],
      );
      expect(conversation.rows[0]!.status).toBe("closed");

      expect(sendToConversation).toHaveBeenCalledWith(
        conversationId,
        expect.stringContaining(ADMIN_USERNAME),
      );
    });

    it("reasignar un ticket en atención al bot lo deja resuelto sin cerrar la conversación, y avisa al cliente", async () => {
      vi.mocked(sendToConversation).mockClear();
      const handoff = await adminPool.query<{ id: string }>(
        `INSERT INTO handoff_queue (conversation_id, reason, status, summary)
         VALUES ($1, 'solicitud_cliente', 'en_atencion', 'Cliente pide un humano')
         RETURNING id`,
        [conversationId],
      );
      const reasignarHandoffId = handoff.rows[0]!.id;
      await adminPool.query(`UPDATE conversations SET status = 'active', bot_paused = true WHERE id = $1`, [
        conversationId,
      ]);

      const response = await app.inject({
        method: "POST",
        url: `/admin/conversaciones/${reasignarHandoffId}/reasignar-bot`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(303);

      const row = await adminPool.query<{ status: string }>(
        `SELECT status FROM handoff_queue WHERE id = $1`,
        [reasignarHandoffId],
      );
      expect(row.rows[0]!.status).toBe("resuelto");

      const conversation = await adminPool.query<{ status: string; bot_paused: boolean }>(
        `SELECT status, bot_paused FROM conversations WHERE id = $1`,
        [conversationId],
      );
      expect(conversation.rows[0]!.status).toBe("active");
      expect(conversation.rows[0]!.bot_paused).toBe(false);

      expect(sendToConversation).toHaveBeenCalledWith(
        conversationId,
        expect.stringContaining(ADMIN_USERNAME),
      );

      await adminPool.query(`DELETE FROM handoff_queue WHERE id = $1`, [reasignarHandoffId]);
    });

    it("una segunda resolución sobre el mismo ticket no rompe (no-op)", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/admin/conversaciones/${handoffId}/resolver`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(303);

      const row = await adminPool.query<{ status: string }>(
        `SELECT status FROM handoff_queue WHERE id = $1`,
        [handoffId],
      );
      expect(row.rows[0]!.status).toBe("resuelto");
    });

    it("pausar el bot de una conversación puntual actualiza conversations.bot_paused, y reactivarlo lo revierte", async () => {
      const desactivar = await app.inject({
        method: "POST",
        url: `/admin/conversaciones/${conversationId}/bot/desactivar`,
        headers: { cookie: sessionCookie },
      });
      expect(desactivar.statusCode).toBe(303);

      const paused = await adminPool.query<{ bot_paused: boolean }>(
        `SELECT bot_paused FROM conversations WHERE id = $1`,
        [conversationId],
      );
      expect(paused.rows[0]!.bot_paused).toBe(true);

      const activar = await app.inject({
        method: "POST",
        url: `/admin/conversaciones/${conversationId}/bot/activar`,
        headers: { cookie: sessionCookie },
      });
      expect(activar.statusCode).toBe(303);

      const resumed = await adminPool.query<{ bot_paused: boolean }>(
        `SELECT bot_paused FROM conversations WHERE id = $1`,
        [conversationId],
      );
      expect(resumed.rows[0]!.bot_paused).toBe(false);
    });

    it("activar/desactivar el bot de una conversación puntual no cambia el filtro desde el que se hizo la acción", async () => {
      // El botón viaja con el `estado` de la página actual en su propia
      // querystring (ver toggleSwitchHtml) — antes el redirect siempre
      // caía en "escaladas" sin importar de dónde vino el admin.
      const desactivar = await app.inject({
        method: "POST",
        url: `/admin/conversaciones/${conversationId}/bot/desactivar?estado=todas`,
        headers: { cookie: sessionCookie },
      });
      expect(desactivar.statusCode).toBe(303);
      expect(desactivar.headers.location).toBe(`/admin/conversaciones?estado=todas&c=${conversationId}`);

      const activar = await app.inject({
        method: "POST",
        url: `/admin/conversaciones/${conversationId}/bot/activar?estado=todas`,
        headers: { cookie: sessionCookie },
      });
      expect(activar.statusCode).toBe(303);
      expect(activar.headers.location).toBe(`/admin/conversaciones?estado=todas&c=${conversationId}`);
    });
  });

  describe("flujo", () => {
    it("muestra el diagrama con los nodos reales del orquestador y los contadores por tool", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/flujo",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("src/orchestrator/loop.ts");
      expect(response.body).toContain("Consultar inventario");
      expect(response.body).toContain("Crear pedido");
      expect(response.body).toContain("Escalar a humano");
      // El único mensaje sembrado con tool_calls (conversacionEscalada)
      // llamó consultar_inventario una vez — el contador debe reflejarlo,
      // no solo listar el nombre de la tool.
      expect(response.body).toMatch(
        /Consultar inventario<\/span><span class="toolpill__count tabular">1<\/span>/,
      );
    });
  });

  describe("conexiones", () => {
    let conexionId: string;

    beforeAll(async () => {
      conexionId = await saveConnection({
        channel: "whatsapp",
        provider: "twilio",
        label: "WhatsApp Panel Test",
        externalId: "whatsapp:+570000000900",
        displayAddress: "whatsapp:+570000000900",
        credentials: { accountSid: "ACpanel", authToken: "token-panel-secreto" },
      });
    });

    afterAll(async () => {
      await adminPool.query(`DELETE FROM channel_connections WHERE id = $1`, [conexionId]);
      invalidateConnectionsCache();
    });

    it("lista las conexiones reales con su número y la URL de webhook", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/conexiones",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("WhatsApp");
      expect(response.body).toContain("Twilio");
      // El número sale de la conexión, no de `settings.whatsapp_number`
      // (columna huérfana desde ADR-032 que hacía que el riel dijera
      // siempre "Sin canal configurado" contradiciendo a esta página).
      expect(response.body).toContain("whatsapp:+570000000900");
      expect(response.body).toContain("/webhooks/whatsapp");
      // Regresión: env.publicWebhookUrl ya es la URL completa del
      // webhook (así la exige la firma de Twilio) — concatenarle el
      // path de nuevo duplicaba "/webhooks/whatsapp" en el enlace a
      // copiar.
      expect(response.body).not.toContain("/webhooks/whatsapp/webhooks/whatsapp");
    });

    it("nunca imprime una credencial en claro en el HTML", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/conexiones",
        headers: { cookie: sessionCookie },
      });
      expect(response.body).not.toContain("token-panel-secreto");
      expect(response.body).not.toContain("ACpanel");
    });

    it("el riel refleja el canal configurado en vez de decir siempre que no hay ninguno", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin",
        headers: { cookie: sessionCookie },
      });
      // No se afirma el texto exacto: depende de cuántas conexiones activas
      // haya sembrado el resto de la suite. Lo que importa es que ya no diga
      // siempre que no hay ninguna, que era el bug.
      expect(response.body).not.toContain("Sin canal configurado");
      expect(response.body).toMatch(/configurado|canales configurados/);
    });

    it("credenciales rechazadas por el proveedor no se guardan y vuelven con error", async () => {
      verifyCredentials.mockRejectedValueOnce(new Error("Authenticate"));
      const response = await app.inject({
        method: "POST",
        url: `/admin/conexiones/${conexionId}/credenciales`,
        headers: { cookie: sessionCookie, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ accountSid: "XXinvalido", authToken: "nuevo" }).toString(),
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain("error=");

      const guardadas = await adminPool.query<{ credentials_encrypted: string }>(
        `SELECT credentials_encrypted FROM channel_connections WHERE id = $1`,
        [conexionId],
      );
      // Sigue estando la credencial vieja: no se persiste nada que el
      // proveedor no haya aceptado (mismo criterio que guardarCobros).
      expect(guardadas.rows[0]!.credentials_encrypted).not.toContain("nuevo");
    });

    it("una cuenta sin números propios (sandbox) guarda igual y conserva la dirección", async () => {
      // Regresión del bug encontrado probando el panel: verifyCredentials no
      // podía deducir el número desde una cuenta de sandbox y el error se
      // reportaba como "el proveedor rechazó las credenciales", mandando al
      // admin a revisar unos datos que estaban bien.
      // El proveedor valida la credencial pero no puede reportar la
      // dirección: exactamente lo que devuelve una cuenta de sandbox.
      verifyCredentials.mockResolvedValueOnce({ externalId: null, displayAddress: null });

      const antes = await adminPool.query<{ external_id: string }>(
        `SELECT external_id FROM channel_connections WHERE id = $1`,
        [conexionId],
      );

      const response = await app.inject({
        method: "POST",
        url: `/admin/conexiones/${conexionId}/credenciales`,
        headers: { cookie: sessionCookie, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ accountSid: "ACsandbox", authToken: "token-nuevo" }).toString(),
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain("guardado=1");

      const despues = await adminPool.query<{ external_id: string }>(
        `SELECT external_id FROM channel_connections WHERE id = $1`,
        [conexionId],
      );
      expect(despues.rows[0]!.external_id).toBe(antes.rows[0]!.external_id);
    });

    it("da de alta una conexión de Meta validando contra el proveedor", async () => {
      // Meta sí reporta la clave de ruteo y la dirección legible, a diferencia
      // de Twilio: ninguna de las dos se toma de lo que tipeó el admin.
      verifyCredentials.mockResolvedValueOnce({
        externalId: "111222333444555",
        displayAddress: "+57 300 555 6666",
      });

      const response = await app.inject({
        method: "POST",
        url: "/admin/conexiones/meta",
        headers: { cookie: sessionCookie, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({
          phoneNumberId: "111222333444555",
          appSecret: "secreto-meta",
          accessToken: "token-meta",
          verifyToken: "verify-meta",
        }).toString(),
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain("guardado=1");

      const fila = await adminPool.query<{ provider: string; external_id: string; display_address: string }>(
        `SELECT provider, external_id, display_address FROM channel_connections WHERE external_id = $1`,
        ["111222333444555"],
      );
      expect(fila.rows[0]).toMatchObject({
        provider: "meta",
        external_id: "111222333444555",
        display_address: "+57 300 555 6666",
      });

      await adminPool.query(`DELETE FROM channel_connections WHERE external_id = $1`, [
        "111222333444555",
      ]);
      invalidateConnectionsCache();
    });

    it("no da de alta una conexión de Meta con credenciales que el proveedor rechaza", async () => {
      verifyCredentials.mockRejectedValueOnce(new Error("Error validating access token"));

      const response = await app.inject({
        method: "POST",
        url: "/admin/conexiones/meta",
        headers: { cookie: sessionCookie, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({
          phoneNumberId: "000111222333444",
          appSecret: "x",
          accessToken: "malo",
          verifyToken: "x",
        }).toString(),
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain("error=");

      const fila = await adminPool.query(
        `SELECT 1 FROM channel_connections WHERE external_id = $1`,
        ["000111222333444"],
      );
      expect(fila.rowCount).toBe(0);
    });

    it("rechaza el alta si falta un campo, sin llamar al proveedor", async () => {
      verifyCredentials.mockClear();
      const response = await app.inject({
        method: "POST",
        url: "/admin/conexiones/meta",
        headers: { cookie: sessionCookie, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ phoneNumberId: "123", appSecret: "x" }).toString(),
      });

      expect(response.headers.location).toContain("error=");
      expect(verifyCredentials).not.toHaveBeenCalled();
    });

    it("un admin que no es master no puede entrar a Conexiones", async () => {
      const passwordHash = await hashPassword("Colab-Conexiones-1");
      await createAdmin(
        "colab conexiones",
        "colab-conexiones@formotos.test",
        passwordHash,
        "colaborador",
        null,
      );
      const loginResponse = await app.inject({
        method: "POST",
        url: "/login",
        payload: new URLSearchParams({
          identifier: "colab-conexiones@formotos.test",
          password: "Colab-Conexiones-1",
        }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      const colabCookie = cookieValueFrom(loginResponse.headers["set-cookie"]);

      const response = await app.inject({
        method: "GET",
        url: "/admin/conexiones",
        headers: { cookie: colabCookie },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe("configuración — voz de marca (Fase 20, ADR-030)", () => {
    it("guarda los campos configurados y los precarga en el formulario", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/admin/configuracion/voz-marca",
        payload: new URLSearchParams({
          nombreAsistente: "Sofía",
          mision: "Vender con confianza.",
          vision: "",
          valores: "Cercanía, honestidad",
          nomenclatura: "",
        }).toString(),
        headers: { cookie: sessionCookie, "content-type": "application/x-www-form-urlencoded" },
      });
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe("/admin/configuracion?guardado=1");

      try {
        const row = await adminPool.query<{ brand_voice_config: Record<string, string> }>(
          `SELECT brand_voice_config FROM settings`,
        );
        expect(row.rows[0]!.brand_voice_config).toMatchObject({
          nombreAsistente: "Sofía",
          mision: "Vender con confianza.",
          valores: "Cercanía, honestidad",
        });

        const configPage = await app.inject({
          method: "GET",
          url: "/admin/configuracion",
          headers: { cookie: sessionCookie },
        });
        expect(configPage.body).toContain("Sofía");
        expect(configPage.body).toContain("Vender con confianza.");
      } finally {
        await adminPool.query(`UPDATE settings SET brand_voice_config = NULL`);
      }
    });

    it("rechaza un campo que supera el largo máximo, sin guardar nada", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/admin/configuracion/voz-marca",
        payload: new URLSearchParams({
          nombreAsistente: "",
          mision: "x".repeat(501),
          vision: "",
          valores: "",
          nomenclatura: "",
        }).toString(),
        headers: { cookie: sessionCookie, "content-type": "application/x-www-form-urlencoded" },
      });
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toContain("error=");

      const row = await adminPool.query<{ brand_voice_config: Record<string, string> | null }>(
        `SELECT brand_voice_config FROM settings`,
      );
      expect(row.rows[0]!.brand_voice_config).toBeNull();
    });
  });

  describe("colaboradores", () => {
    it("un master ve la lista de colaboradores existentes", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/admin/colaboradores",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(ADMIN_EMAIL);
      expect(response.body).toContain("Master");
    });

    it("crea un colaborador nuevo, que puede loguearse pero no ver Colaboradores", async () => {
      const nuevoEmail = "nuevo.colaborador@formotos-test.com";
      const nuevaPassword = "otra-clave-de-prueba";

      const crear = await app.inject({
        method: "POST",
        url: "/admin/colaboradores",
        payload: new URLSearchParams({
          username: "nuevo.colaborador",
          email: nuevoEmail,
          password: nuevaPassword,
          role: "colaborador",
        }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie },
      });
      expect(crear.statusCode).toBe(303);
      expect(crear.headers.location).toBe("/admin/colaboradores?guardado=1");

      const lista = await app.inject({
        method: "GET",
        url: "/admin/colaboradores",
        headers: { cookie: sessionCookie },
      });
      expect(lista.body).toContain(nuevoEmail);
      expect(lista.body).toContain("Colaborador");

      const loginColaborador = await app.inject({
        method: "POST",
        url: "/login",
        payload: new URLSearchParams({ identifier: nuevoEmail, password: nuevaPassword }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      expect(loginColaborador.statusCode).toBe(303);
      const colaboradorCookie = cookieValueFrom(loginColaborador.headers["set-cookie"]);

      // Puede ver el resto del panel...
      const overview = await app.inject({
        method: "GET",
        url: "/admin",
        headers: { cookie: colaboradorCookie },
      });
      expect(overview.statusCode).toBe(200);

      // ...pero no la sección de Colaboradores (solo master, ver ADR-025).
      const colaboradores = await app.inject({
        method: "GET",
        url: "/admin/colaboradores",
        headers: { cookie: colaboradorCookie },
      });
      expect(colaboradores.statusCode).toBe(403);

      // El bloqueo cubre las acciones (POST), no solo la vista (GET) —
      // un colaborador no puede crear otro admin aunque sepa la URL.
      const intentoCrear = await app.inject({
        method: "POST",
        url: "/admin/colaboradores",
        payload: new URLSearchParams({
          username: "intruso",
          email: "intruso@formotos-test.com",
          password: "clave-cualquiera",
          role: "master",
        }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: colaboradorCookie },
      });
      expect(intentoCrear.statusCode).toBe(403);
      const buscaIntruso = await adminPool.query(
        `SELECT 1 FROM admins WHERE email = 'intruso@formotos-test.com'`,
      );
      expect(buscaIntruso.rowCount).toBe(0);
    });

    it("una sesión expirada se trata igual que una inválida", async () => {
      const email = "sesion-expirada@formotos-test.com";
      const password = "clave-sesion-expirada";
      await app.inject({
        method: "POST",
        url: "/admin/colaboradores",
        payload: new URLSearchParams({ username: "sesion-expirada", email, password, role: "colaborador" }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie },
      });

      const login = await app.inject({
        method: "POST",
        url: "/login",
        payload: new URLSearchParams({ identifier: email, password }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      const cookie = cookieValueFrom(login.headers["set-cookie"]);
      const token = cookie.split("=")[1]!.split(";")[0]!;

      // Todavía válida.
      const antes = await app.inject({ method: "GET", url: "/admin", headers: { cookie } });
      expect(antes.statusCode).toBe(200);

      await adminPool.query(
        `UPDATE admin_sessions SET expires_at = now() - interval '1 minute' WHERE token = $1`,
        [decodeURIComponent(token)],
      );

      const despues = await app.inject({ method: "GET", url: "/admin", headers: { cookie } });
      expect(despues.statusCode).toBe(303);
      expect(despues.headers.location).toBe("/login");
    });

    it("desactivar un colaborador le bloquea el login de inmediato", async () => {
      const email = "para-desactivar@formotos-test.com";
      const password = "clave-para-desactivar";

      await app.inject({
        method: "POST",
        url: "/admin/colaboradores",
        payload: new URLSearchParams({ username: "para-desactivar", email, password, role: "colaborador" }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie },
      });

      const primerLogin = await app.inject({
        method: "POST",
        url: "/login",
        payload: new URLSearchParams({ identifier: email, password }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      expect(primerLogin.statusCode).toBe(303);
      const cookieAntesDesactivar = cookieValueFrom(primerLogin.headers["set-cookie"]);

      // Se busca el id directo en la base por email — scrapear el HTML
      // de la tabla es frágil acá: ya hay más de un colaborador activo
      // sembrado por los tests anteriores de este mismo describe, y
      // "el primer link .../desactivar" no necesariamente es el de este.
      const adminRow = await adminPool.query<{ id: string }>(`SELECT id FROM admins WHERE email = $1`, [
        email,
      ]);
      const adminId = adminRow.rows[0]!.id;

      const desactivar = await app.inject({
        method: "POST",
        url: `/admin/colaboradores/${adminId}/desactivar`,
        headers: { cookie: sessionCookie },
      });
      expect(desactivar.statusCode).toBe(303);

      // La sesión ya creada deja de servir de inmediato (chequeo de
      // admins.active en cada request, no solo al login — ver ADR-025).
      const overviewConSesionVieja = await app.inject({
        method: "GET",
        url: "/admin",
        headers: { cookie: cookieAntesDesactivar },
      });
      expect(overviewConSesionVieja.statusCode).toBe(303);
      expect(overviewConSesionVieja.headers.location).toBe("/login");

      // Y ya no puede volver a loguearse.
      const segundoLogin = await app.inject({
        method: "POST",
        url: "/login",
        payload: new URLSearchParams({ identifier: email, password }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      expect(segundoLogin.statusCode).toBe(401);
    });

    it("guarda los permisos de un colaborador", async () => {
      const email = "con-permisos@formotos-test.com";
      await app.inject({
        method: "POST",
        url: "/admin/colaboradores",
        payload: new URLSearchParams({
          username: "con-permisos",
          email,
          password: "clave-de-permisos",
          role: "colaborador",
        }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie },
      });

      // Mismo criterio que en el test de desactivar: buscar el id por
      // email directo en la base, no scrapear "el primer link .../permisos"
      // (todas las filas, incluida la del master, tienen ese formulario).
      const adminRow = await adminPool.query<{ id: string }>(`SELECT id FROM admins WHERE email = $1`, [
        email,
      ]);
      const adminId = adminRow.rows[0]!.id;

      const guardar = await app.inject({
        method: "POST",
        url: `/admin/colaboradores/${adminId}/permisos`,
        payload: new URLSearchParams({ recibeTickets: "on" }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie },
      });
      expect(guardar.statusCode).toBe(303);

      const row = await adminPool.query<{
        recibe_tickets: boolean;
        recibe_reporte_diario: boolean;
      }>(`SELECT recibe_tickets, recibe_reporte_diario FROM admin_permissions WHERE admin_id = $1`, [
        adminId,
      ]);
      expect(row.rows[0]!.recibe_tickets).toBe(true);
      expect(row.rows[0]!.recibe_reporte_diario).toBe(false);
    });

    it("rechaza crear un colaborador con contraseña corta o email repetido", async () => {
      const corta = await app.inject({
        method: "POST",
        url: "/admin/colaboradores",
        payload: new URLSearchParams({
          username: "clave-corta",
          email: "clave-corta@formotos-test.com",
          password: "123",
          role: "colaborador",
        }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie },
      });
      expect(corta.statusCode).toBe(303);
      expect(corta.headers.location).toContain("error=");

      const repetido = await app.inject({
        method: "POST",
        url: "/admin/colaboradores",
        payload: new URLSearchParams({
          username: "repetido-correo",
          email: ADMIN_EMAIL,
          password: "clave-valida-larga",
          role: "colaborador",
        }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie },
      });
      expect(repetido.statusCode).toBe(303);
      expect(repetido.headers.location).toContain("error=");
    });
  });
});
