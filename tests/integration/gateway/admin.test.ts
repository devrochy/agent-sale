import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../../src/admin/auth/passwordHash.js";
import { buildServer } from "../../../src/gateway/server.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

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

let tenantA: string;
let tenantB: string;
let conversacionAbierta: string;
let conversacionEscalada: string;
let conversacionCerrada: string;
let sessionCookie: string;
const app = await buildServer();

beforeAll(async () => {
  const a = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Admin Panel Test A') RETURNING id`,
  );
  tenantA = a.rows[0]!.id;
  const b = await adminPool.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Admin Panel Test B') RETURNING id`,
  );
  tenantB = b.rows[0]!.id;

  await adminPool.query(
    `INSERT INTO products (tenant_id, sku, name, price, description, image_url)
     VALUES ($1, 'ADMIN-A', 'Casco Panel A', 250000, 'Casco de prueba del panel A', 'https://picsum.photos/seed/ADMIN-A/600/400')`,
    [tenantA],
  );
  await adminPool.query(
    `INSERT INTO products (tenant_id, sku, name, price)
     VALUES ($1, 'ADMIN-B', 'Casco Panel B', 260000)`,
    [tenantB],
  );

  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, phone_number, name) VALUES ($1, 'whatsapp:+573000000000', 'Cliente Overview') RETURNING id`,
    [tenantA],
  );
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id`,
    [tenantA, customer.rows[0]!.id],
  );
  conversacionAbierta = conversation.rows[0]!.id;
  await adminPool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content)
     VALUES ($1, $2, 'inbound', 'customer', 'Hola, ¿tienen cascos?')`,
    [tenantA, conversation.rows[0]!.id],
  );

  // Conversación escalada — inbox de Conversaciones (Fase 11.2): el
  // mensaje trae tool_calls para probar que la vista reusa el mismo
  // renderMessageBody() del inbox del asesor (handoffView.ts).
  const customerEscalado = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, phone_number, name) VALUES ($1, 'whatsapp:+573000000001', 'Cliente Escalado') RETURNING id`,
    [tenantA],
  );
  const conversationEscalada = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id`,
    [tenantA, customerEscalado.rows[0]!.id],
  );
  conversacionEscalada = conversationEscalada.rows[0]!.id;
  await adminPool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content, tool_calls)
     VALUES ($1, $2, 'outbound', 'agent', '', $3::jsonb)`,
    [
      tenantA,
      conversationEscalada.rows[0]!.id,
      JSON.stringify([
        { type: "tool_use", name: "consultar_inventario", input: { query: "cascos" } },
      ]),
    ],
  );
  const agent = await adminPool.query<{ id: string }>(
    `INSERT INTO human_agents (tenant_id, name, contact) VALUES ($1, 'Laura Vélez', 'laura@formotos.test') RETURNING id`,
    [tenantA],
  );
  await adminPool.query(
    `INSERT INTO handoff_queue (tenant_id, conversation_id, reason, status, assigned_to)
     VALUES ($1, $2, 'solicitud_cliente', 'en_atencion', $3)`,
    [tenantA, conversationEscalada.rows[0]!.id, agent.rows[0]!.id],
  );

  // Ticket de riesgo ("Vigilante", Fase 12.1) — reason 'queja' debe
  // resaltarse distinto de un escalamiento rutinario como el de arriba.
  const customerQueja = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, phone_number, name) VALUES ($1, 'whatsapp:+573000000005', 'Cliente Molesto') RETURNING id`,
    [tenantA],
  );
  const conversationQueja = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id`,
    [tenantA, customerQueja.rows[0]!.id],
  );
  await adminPool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content)
     VALUES ($1, $2, 'inbound', 'customer', 'Esto es un desastre, llevo dos semanas esperando')`,
    [tenantA, conversationQueja.rows[0]!.id],
  );
  await adminPool.query(
    `INSERT INTO handoff_queue (tenant_id, conversation_id, reason, status)
     VALUES ($1, $2, 'queja', 'queued')`,
    [tenantA, conversationQueja.rows[0]!.id],
  );

  // Conversación cerrada — cubre el tab "Cerradas".
  const customerCerrado = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, phone_number) VALUES ($1, 'whatsapp:+573000000002') RETURNING id`,
    [tenantA],
  );
  const conversationCerrada = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, customer_id, status, closed_at) VALUES ($1, $2, 'closed', now()) RETURNING id`,
    [tenantA, customerCerrado.rows[0]!.id],
  );
  conversacionCerrada = conversationCerrada.rows[0]!.id;
  await adminPool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content)
     VALUES ($1, $2, 'inbound', 'customer', 'Gracias, ya no necesito nada más')`,
    [tenantA, conversationCerrada.rows[0]!.id],
  );

  // Leads con cotización y con pedido — cubren las 4 categorías del
  // funnel de metricas-cierre-ventas.md que la vista de Leads reusa.
  const customerCotizacion = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, phone_number, name) VALUES ($1, 'whatsapp:+573000000003', 'Cliente Con Cotización') RETURNING id`,
    [tenantA],
  );
  const conversationCotizacion = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id`,
    [tenantA, customerCotizacion.rows[0]!.id],
  );
  await adminPool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content)
     VALUES ($1, $2, 'inbound', 'customer', 'Quiero cotizar un casco')`,
    [tenantA, conversationCotizacion.rows[0]!.id],
  );
  // Regresión: el orquestador también guarda los tool_results como
  // inbound/agent con content vacío (ver loop.ts) — este mensaje, más
  // reciente que el del cliente, no debe ganarle al heurístico de
  // "último mensaje" de Leads.
  await adminPool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content)
     VALUES ($1, $2, 'inbound', 'agent', '')`,
    [tenantA, conversationCotizacion.rows[0]!.id],
  );
  await adminPool.query(
    `INSERT INTO quotes (tenant_id, conversation_id, customer_id, subtotal, total)
     VALUES ($1, $2, $3, 250000, 250000)`,
    [tenantA, conversationCotizacion.rows[0]!.id, customerCotizacion.rows[0]!.id],
  );

  const customerPedido = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, phone_number, name) VALUES ($1, 'whatsapp:+573000000004', 'Cliente Con Pedido') RETURNING id`,
    [tenantA],
  );
  const conversationPedido = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id`,
    [tenantA, customerPedido.rows[0]!.id],
  );
  await adminPool.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content)
     VALUES ($1, $2, 'inbound', 'customer', 'Confirmo el pedido')`,
    [tenantA, conversationPedido.rows[0]!.id],
  );
  const quotePedido = await adminPool.query<{ id: string }>(
    `INSERT INTO quotes (tenant_id, conversation_id, customer_id, subtotal, total)
     VALUES ($1, $2, $3, 250000, 250000) RETURNING id`,
    [tenantA, conversationPedido.rows[0]!.id, customerPedido.rows[0]!.id],
  );
  await adminPool.query(
    `INSERT INTO orders (tenant_id, quote_id, conversation_id, customer_id, payment_method, delivery_method, idempotency_key, total)
     VALUES ($1, $2, $3, $4, 'transferencia', 'domicilio', 'admin-test-order-1', 250000)`,
    [tenantA, quotePedido.rows[0]!.id, conversationPedido.rows[0]!.id, customerPedido.rows[0]!.id],
  );

  // Admin real (Fase 13, ver ADR-025) para autenticar el resto de los
  // tests — role='master' para no depender de permisos granulares acá
  // (esos se prueban en tests/unit de src/admin/auth/).
  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  const adminRow = await adminPool.query<{ id: string }>(
    `INSERT INTO admins (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, 'master') RETURNING id`,
    [tenantA, ADMIN_EMAIL, passwordHash],
  );
  await adminPool.query(`INSERT INTO admin_permissions (admin_id, tenant_id) VALUES ($1, $2)`, [
    adminRow.rows[0]!.id,
    tenantA,
  ]);

  await app.ready();

  const loginResponse = await app.inject({
    method: "POST",
    url: `/admin/${tenantA}/login`,
    payload: new URLSearchParams({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  sessionCookie = cookieValueFrom(loginResponse.headers["set-cookie"]);
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM admin_sessions WHERE tenant_id IN ($1, $2)`, [
    tenantA,
    tenantB,
  ]);
  await adminPool.query(`DELETE FROM admin_permissions WHERE tenant_id IN ($1, $2)`, [
    tenantA,
    tenantB,
  ]);
  await adminPool.query(`DELETE FROM admins WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM order_items WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM orders WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM quote_items WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM quotes WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM handoff_queue WHERE tenant_id IN ($1, $2)`, [
    tenantA,
    tenantB,
  ]);
  await adminPool.query(`DELETE FROM human_agents WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM messages WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM conversations WHERE tenant_id IN ($1, $2)`, [
    tenantA,
    tenantB,
  ]);
  await adminPool.query(`DELETE FROM customers WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM products WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]);
  await adminPool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [tenantA, tenantB]);
  await app.close();
  await adminPool.end();
  await appPool.end();
});

describe("panel admin", () => {
  it("GET /admin (sin tenant) no expone ningún dato y no requiere sesión", async () => {
    const response = await app.inject({ method: "GET", url: "/admin" });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("Admin Panel Test A");
    expect(response.body).not.toContain("Admin Panel Test B");
  });

  it("redirige a /login sin sesión", async () => {
    const response = await app.inject({ method: "GET", url: `/admin/${tenantA}` });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`/admin/${tenantA}/login`);
  });

  it("redirige a /login con una cookie de sesión inválida", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/admin/${tenantA}`,
      headers: { cookie: "agent_sale_admin_session=token-que-no-existe" },
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`/admin/${tenantA}/login`);
  });

  it("login con contraseña incorrecta no autentica", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/admin/${tenantA}/login`,
      payload: new URLSearchParams({ email: ADMIN_EMAIL, password: "clave-incorrecta" }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("Correo o contraseña incorrectos");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("login correcto autentica y logout invalida la sesión", async () => {
    const loginResponse = await app.inject({
      method: "POST",
      url: `/admin/${tenantA}/login`,
      payload: new URLSearchParams({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(loginResponse.statusCode).toBe(303);
    expect(loginResponse.headers.location).toBe(`/admin/${tenantA}`);
    const cookie = cookieValueFrom(loginResponse.headers["set-cookie"]);

    const overview = await app.inject({
      method: "GET",
      url: `/admin/${tenantA}`,
      headers: { cookie },
    });
    expect(overview.statusCode).toBe(200);

    const logoutResponse = await app.inject({
      method: "POST",
      url: `/admin/${tenantA}/logout`,
      headers: { cookie },
    });
    expect(logoutResponse.statusCode).toBe(303);
    expect(logoutResponse.headers.location).toBe(`/admin/${tenantA}/login`);

    const afterLogout = await app.inject({
      method: "GET",
      url: `/admin/${tenantA}`,
      headers: { cookie },
    });
    expect(afterLogout.statusCode).toBe(303);
    expect(afterLogout.headers.location).toBe(`/admin/${tenantA}/login`);
  });

  it("una sesión de un tenant no sirve para la URL de otro tenant", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/admin/${tenantB}`,
      headers: { cookie: sessionCookie },
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`/admin/${tenantB}/login`);
  });

  it("muestra el catálogo de un tenant sin filtrar productos de otro", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/admin/${tenantA}/productos`,
      headers: { cookie: sessionCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Casco Panel A");
    expect(response.body).toContain("Casco de prueba del panel A");
    expect(response.body).not.toContain("Casco Panel B");
  });

  it("muestra la página de pedidos de un tenant", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/admin/${tenantA}/pedidos`,
      headers: { cookie: sessionCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Pedidos");
  });

  it("muestra el resumen de un tenant con marca por default (name), KPIs y conversaciones recientes", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/admin/${tenantA}`,
      headers: { cookie: sessionCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Admin Panel Test A");
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

  it("usa display_name como marca cuando el tenant lo configura", async () => {
    await adminPool.query(`UPDATE tenants SET display_name = 'Marca Personalizada' WHERE id = $1`, [
      tenantA,
    ]);
    const response = await app.inject({
      method: "GET",
      url: `/admin/${tenantA}`,
      headers: { cookie: sessionCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Marca Personalizada");
    await adminPool.query(`UPDATE tenants SET display_name = NULL WHERE id = $1`, [tenantA]);
  });

  it("redirige a login para un tenant que no existe (no distingue con un 404)", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/admin/00000000-0000-0000-0000-000000000000`,
      headers: { cookie: sessionCookie },
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/admin/00000000-0000-0000-0000-000000000000/login");
  });

  describe("conversaciones", () => {
    it("lista las conversaciones del tenant con el nombre real del cliente", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/conversaciones`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Cliente Overview");
      expect(response.body).toContain("Cliente Escalado");
      // Sin cliente sembrado como número puro (whatsapp:+573000000002)
      // cae al fallback de mostrar el teléfono.
      expect(response.body).toContain("whatsapp:+573000000002");
    });

    it("el tab Escaladas solo muestra conversaciones con handoff abierto", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/conversaciones?estado=escaladas`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Cliente Escalado");
      expect(response.body).not.toContain("Cliente Overview");
    });

    it("el tab Cerradas solo muestra conversaciones cerradas", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/conversaciones?estado=cerradas`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("whatsapp:+573000000002");
      expect(response.body).not.toContain("Cliente Overview");
    });

    it("muestra el historial completo de una conversación seleccionada, incluida la tool ejecutada", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/conversaciones?c=${conversacionAbierta}`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Hola, ¿tienen cascos?");
    });

    it("muestra qué tool se ejecutó cuando el mensaje trae tool_calls", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/conversaciones?c=${conversacionEscalada}`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("tool: consultar_inventario");
    });

    it("marca la conversación cerrada como tal en el detalle", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/conversaciones?estado=cerradas&c=${conversacionCerrada}`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Gracias, ya no necesito nada más");
      expect(response.body).toContain("cerrada");
    });

    it("redirige a login para un tenant que no existe (no distingue con un 404)", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/00000000-0000-0000-0000-000000000000/conversaciones`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe("/admin/00000000-0000-0000-0000-000000000000/login");
    });
  });

  describe("leads", () => {
    it("clasifica cada cliente en su estado real del funnel comercial", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/leads`,
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

    it("el último mensaje ignora los tool_results vacíos y muestra el texto real del cliente", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/leads`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Quiero cotizar un casco");
    });

    it("exporta el mismo listado como CSV descargable", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/leads.csv`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/csv");
      expect(response.headers["content-disposition"]).toContain("leads.csv");
      expect(response.body).toContain("nombre,telefono,ultimo_mensaje,estado,cliente_desde");
      expect(response.body).toContain("Cliente Con Pedido");
      // Regresión: pg parsea timestamptz como objeto Date, no string — un
      // .toString() implícito al armar el CSV a mano produce
      // "Wed Jul 29 2026 03:09:20 GMT-0500 (...)" en vez de una fecha ISO.
      expect(response.body).not.toContain("GMT");
      expect(response.body).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("redirige a login para un tenant que no existe (HTML y CSV)", async () => {
      const html = await app.inject({
        method: "GET",
        url: `/admin/00000000-0000-0000-0000-000000000000/leads`,
        headers: { cookie: sessionCookie },
      });
      expect(html.statusCode).toBe(303);
      expect(html.headers.location).toBe("/admin/00000000-0000-0000-0000-000000000000/login");
      const csv = await app.inject({
        method: "GET",
        url: `/admin/00000000-0000-0000-0000-000000000000/leads.csv`,
        headers: { cookie: sessionCookie },
      });
      expect(csv.statusCode).toBe(303);
      expect(csv.headers.location).toBe("/admin/00000000-0000-0000-0000-000000000000/login");
    });
  });

  describe("tickets", () => {
    it("lista los casos escalados con motivo, estado y asesor asignado", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/tickets`,
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
        url: `/admin/${tenantA}/tickets`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatch(/chip chip--redline"[^>]*>⚠ Queja/);
      // El escalamiento rutinario (solicitud_cliente) no lleva el marcador de riesgo.
      expect(response.body).not.toMatch(/⚠ Solicitud del cliente/);
    });

    it("enlaza cada ticket a su conversación en el inbox", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/tickets`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(
        `/admin/${tenantA}/conversaciones?estado=escaladas&c=${conversacionEscalada}`,
      );
    });

    it("redirige a login para un tenant que no existe (no distingue con un 404)", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/00000000-0000-0000-0000-000000000000/tickets`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe("/admin/00000000-0000-0000-0000-000000000000/login");
    });
  });

  describe("flujo", () => {
    it("muestra el diagrama con los nodos reales del orquestador y los contadores por tool", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/flujo`,
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

    it("redirige a login para un tenant que no existe (no distingue con un 404)", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/00000000-0000-0000-0000-000000000000/flujo`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe("/admin/00000000-0000-0000-0000-000000000000/login");
    });
  });

  describe("conexiones", () => {
    it("muestra el estado real de la conexión de WhatsApp/Twilio y la URL de webhook", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/conexiones`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("WhatsApp");
      expect(response.body).toContain("Twilio");
      expect(response.body).toContain("Conectado");
      expect(response.body).toContain("/webhooks/whatsapp");
      expect(response.body).toContain("Sin asignar");
      // Regresión: env.publicWebhookUrl ya es la URL completa del
      // webhook (la exige así twilioSignature.ts) — concatenarle el
      // path de nuevo duplicaba "/webhooks/whatsapp" en el enlace a
      // copiar.
      expect(response.body).not.toContain("/webhooks/whatsapp/webhooks/whatsapp");
    });

    it("redirige a login para un tenant que no existe (no distingue con un 404)", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/00000000-0000-0000-0000-000000000000/conexiones`,
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe("/admin/00000000-0000-0000-0000-000000000000/login");
    });
  });
});
