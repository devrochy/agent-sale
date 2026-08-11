import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  getWhatsAppMessageStatus: vi.fn(),
}));

import { getWhatsAppMessageStatus, sendWhatsAppMessage } from "../../../src/gateway/sendMessage.js";
import { buildServer } from "../../../src/gateway/server.js";
import { renderHandoffView } from "../../../src/advisor/handoffView.js";
import { createHandoffToken } from "../../../src/shared/db/handoffTokenDirectory.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
const app = await buildServer();

let customerId: string;
let conversationId: string;

afterEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(getWhatsAppMessageStatus).mockReset();
});

beforeAll(async () => {
  await app.ready();

  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id, name) VALUES ('3050000001', 'Cliente Test') RETURNING id`,
  );
  customerId = customer.rows[0]!.id;

  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id, state) VALUES ($1, $2) RETURNING id`,
    [customerId, JSON.stringify({ step: "escalado" })],
  );
  conversationId = conversation.rows[0]!.id;

  await adminPool.query(
    `INSERT INTO messages (conversation_id, direction, sender_type, content)
     VALUES ($1, 'inbound', 'customer', $2)`,
    [conversationId, "<script>alert(1)</script> tienen cascos?"],
  );
});

afterAll(async () => {
  await adminPool.query(
    `DELETE FROM handoff_tokens WHERE handoff_id IN (SELECT id FROM handoff_queue WHERE conversation_id = $1)`,
    [conversationId],
  );
  await adminPool.query(`DELETE FROM handoff_queue WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM messages WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  await app.close();
  await adminPool.end();
  await appPool.end();
});

async function seedHandoff(): Promise<{ handoffId: string; token: string }> {
  const handoff = await adminPool.query<{ id: string }>(
    `INSERT INTO handoff_queue (conversation_id, reason, status, summary)
     VALUES ($1, 'queja', 'queued', 'Cliente molesto, quiere hablar con alguien.')
     RETURNING id`,
    [conversationId],
  );
  const handoffId = handoff.rows[0]!.id;
  const token = await createHandoffToken(handoffId);
  return { handoffId, token };
}

describe("renderHandoffView", () => {
  it("devuelve 404 si el token no existe", async () => {
    const result = await renderHandoffView("token-invalido");
    expect(result.status).toBe(404);
  });

  it("renderiza la vista de solo lectura con los datos del cliente, el motivo y el historial, escapando HTML, sin botones de acción", async () => {
    const { token } = await seedHandoff();

    const result = await renderHandoffView(token);

    expect(result.status).toBe(200);
    expect(result.html).toContain("3050000001");
    expect(result.html).toContain("Cliente Test");
    expect(result.html).toContain("queja");
    expect(result.html).toContain("Cliente molesto");
    expect(result.html).not.toContain("<script>alert(1)</script>");
    expect(result.html).toContain("&lt;script&gt;");

    // ADR-028 (Fase 18, Opción 3): el enlace es de solo lectura, sin
    // acciones de tomar/resolver, y dirige al panel autenticado.
    expect(result.html).not.toContain("/tomar");
    expect(result.html).not.toContain("/resolver");
    expect(result.html).toContain("/admin/conversaciones");
  });
});

describe("rutas HTTP /asesor", () => {
  it("GET /asesor/:token responde 200 con la página", async () => {
    const { token } = await seedHandoff();

    const response = await app.inject({ method: "GET", url: `/asesor/${token}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Conversación escalada");
  });

  it("GET /asesor/:token con token inválido responde 404", async () => {
    const response = await app.inject({ method: "GET", url: "/asesor/no-existe" });
    expect(response.statusCode).toBe(404);
  });

  it("POST /asesor/:token/tomar redirige al login (ADR-028, retirado del flujo de token)", async () => {
    const { token } = await seedHandoff();

    const response = await app.inject({ method: "POST", url: `/asesor/${token}/tomar` });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/login");
  });

  it("POST /asesor/:token/resolver redirige al login (ADR-028, retirado del flujo de token)", async () => {
    const { token } = await seedHandoff();

    const response = await app.inject({ method: "POST", url: `/asesor/${token}/resolver` });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/login");
  });
});
