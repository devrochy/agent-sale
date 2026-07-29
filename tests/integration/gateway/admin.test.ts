import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../../src/config/env.js";
import { buildServer } from "../../../src/gateway/server.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const AUTH_HEADER = `Basic ${Buffer.from(`${env.adminUser}:${env.adminPassword}`).toString("base64")}`;

let tenantA: string;
let tenantB: string;
let conversacionAbierta: string;
let conversacionEscalada: string;
let conversacionCerrada: string;
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
      JSON.stringify([{ type: "tool_use", name: "consultar_inventario", input: { query: "cascos" } }]),
    ],
  );
  await adminPool.query(
    `INSERT INTO handoff_queue (tenant_id, conversation_id, reason, status)
     VALUES ($1, $2, 'solicitud_cliente', 'queued')`,
    [tenantA, conversationEscalada.rows[0]!.id],
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

  await app.ready();
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM handoff_queue WHERE tenant_id IN ($1, $2)`, [
    tenantA,
    tenantB,
  ]);
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
  it("rechaza sin credenciales", async () => {
    const response = await app.inject({ method: "GET", url: "/admin" });
    expect(response.statusCode).toBe(401);
  });

  it("rechaza con credenciales incorrectas", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: "Basic aW5jb3JyZWN0OmNyZWRz" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("lista los tenants con credenciales correctas", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: AUTH_HEADER },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Admin Panel Test A");
    expect(response.body).toContain("Admin Panel Test B");
  });

  it("muestra el catálogo de un tenant sin filtrar productos de otro", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/admin/${tenantA}/productos`,
      headers: { authorization: AUTH_HEADER },
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
      headers: { authorization: AUTH_HEADER },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Pedidos");
  });

  it("muestra el resumen de un tenant con marca por default (name), KPIs y conversaciones recientes", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/admin/${tenantA}`,
      headers: { authorization: AUTH_HEADER },
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
      headers: { authorization: AUTH_HEADER },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Marca Personalizada");
    await adminPool.query(`UPDATE tenants SET display_name = NULL WHERE id = $1`, [tenantA]);
  });

  it("devuelve 404 para un tenant que no existe", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/admin/00000000-0000-0000-0000-000000000000`,
      headers: { authorization: AUTH_HEADER },
    });
    expect(response.statusCode).toBe(404);
  });

  describe("conversaciones", () => {
    it("lista las conversaciones del tenant con el nombre real del cliente", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/conversaciones`,
        headers: { authorization: AUTH_HEADER },
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
        headers: { authorization: AUTH_HEADER },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Cliente Escalado");
      expect(response.body).not.toContain("Cliente Overview");
    });

    it("el tab Cerradas solo muestra conversaciones cerradas", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/conversaciones?estado=cerradas`,
        headers: { authorization: AUTH_HEADER },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("whatsapp:+573000000002");
      expect(response.body).not.toContain("Cliente Overview");
    });

    it("muestra el historial completo de una conversación seleccionada, incluida la tool ejecutada", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/conversaciones?c=${conversacionAbierta}`,
        headers: { authorization: AUTH_HEADER },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Hola, ¿tienen cascos?");
    });

    it("muestra qué tool se ejecutó cuando el mensaje trae tool_calls", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/conversaciones?c=${conversacionEscalada}`,
        headers: { authorization: AUTH_HEADER },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("tool: consultar_inventario");
    });

    it("marca la conversación cerrada como tal en el detalle", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/${tenantA}/conversaciones?estado=cerradas&c=${conversacionCerrada}`,
        headers: { authorization: AUTH_HEADER },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Gracias, ya no necesito nada más");
      expect(response.body).toContain("cerrada");
    });

    it("devuelve 404 para un tenant que no existe", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/admin/00000000-0000-0000-0000-000000000000/conversaciones`,
        headers: { authorization: AUTH_HEADER },
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
