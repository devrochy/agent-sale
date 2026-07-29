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

  await app.ready();
});

afterAll(async () => {
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
});
