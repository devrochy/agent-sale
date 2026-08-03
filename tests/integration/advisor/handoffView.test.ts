import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  getWhatsAppMessageStatus: vi.fn(),
}));

import { getWhatsAppMessageStatus, sendWhatsAppMessage } from "../../../src/gateway/sendMessage.js";
import { buildServer } from "../../../src/gateway/server.js";
import {
  renderHandoffView,
  resolverConversacion,
  tomarConversacion,
} from "../../../src/advisor/handoffView.js";
import { createHandoffToken } from "../../../src/shared/db/handoffTokenDirectory.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
const app = await buildServer();

let customerId: string;
let conversationId: string;
let agentId: string;

afterEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(getWhatsAppMessageStatus).mockReset();
});

beforeAll(async () => {
  await app.ready();

  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (phone_number, name) VALUES ('3050000001', 'Cliente Test') RETURNING id`,
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

  const agent = await adminPool.query<{ id: string }>(
    `INSERT INTO human_agents (name, contact, active) VALUES ('Asesor View', 'whatsapp:+573007777777', true) RETURNING id`,
  );
  agentId = agent.rows[0]!.id;
});

afterAll(async () => {
  await adminPool.query(
    `DELETE FROM handoff_tokens WHERE handoff_id IN (SELECT id FROM handoff_queue WHERE conversation_id = $1)`,
    [conversationId],
  );
  await adminPool.query(`DELETE FROM handoff_queue WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM human_agents WHERE id = $1`, [agentId]);
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
  const token = await createHandoffToken(handoffId, agentId);
  return { handoffId, token };
}

describe("renderHandoffView", () => {
  it("devuelve 404 si el token no existe", async () => {
    const result = await renderHandoffView("token-invalido");
    expect(result.status).toBe(404);
  });

  it("renderiza la vista con los datos del cliente, el motivo y el historial, escapando HTML", async () => {
    const { token } = await seedHandoff();

    const result = await renderHandoffView(token);

    expect(result.status).toBe(200);
    expect(result.html).toContain("3050000001");
    expect(result.html).toContain("Cliente Test");
    expect(result.html).toContain("queja");
    expect(result.html).toContain("Cliente molesto");
    expect(result.html).not.toContain("<script>alert(1)</script>");
    expect(result.html).toContain("&lt;script&gt;");
  });
});

describe("tomarConversacion / resolverConversacion", () => {
  it("tomar pasa el caso a en_atencion y lo asigna al asesor del token", async () => {
    const { handoffId, token } = await seedHandoff();

    const result = await tomarConversacion(token);
    expect(result.status).toBe(200);

    const row = await adminPool.query(
      `SELECT status, assigned_to FROM handoff_queue WHERE id = $1`,
      [handoffId],
    );
    expect(row.rows[0]).toMatchObject({ status: "en_atencion", assigned_to: agentId });
  });

  it("tomar sobre un caso que ya no está 'queued' devuelve 409", async () => {
    const { token } = await seedHandoff();
    await tomarConversacion(token);

    const result = await tomarConversacion(token);
    expect(result.status).toBe(409);
  });

  it("resolver pasa el caso a resuelto, completa resolved_at, cierra la conversación y manda la encuesta", async () => {
    vi.mocked(sendWhatsAppMessage).mockResolvedValue("SM_TEST_SID");
    vi.mocked(getWhatsAppMessageStatus).mockResolvedValue({ status: "delivered", errorCode: null });

    const { handoffId, token } = await seedHandoff();
    await tomarConversacion(token);

    const result = await resolverConversacion(token);
    expect(result.status).toBe(200);

    const row = await adminPool.query(
      `SELECT status, resolved_at FROM handoff_queue WHERE id = $1`,
      [handoffId],
    );
    expect(row.rows[0]!.status).toBe("resuelto");
    expect(row.rows[0]!.resolved_at).not.toBeNull();

    // Cierra la conversación (ver handoff-queue.md, "reasignación y
    // cierre") para que el próximo mensaje del cliente abra una nueva en
    // vez de quedar muda en step: "escalado" para siempre.
    const conversation = await adminPool.query(
      `SELECT status, closed_at, survey_sent_at FROM conversations WHERE id = $1`,
      [conversationId],
    );
    expect(conversation.rows[0]!.status).toBe("closed");
    expect(conversation.rows[0]!.closed_at).not.toBeNull();

    // Encuesta de satisfacción (Fase 12.2, ver satisfactionSurvey.ts): se
    // manda automáticamente al cerrar, best-effort.
    expect(conversation.rows[0]!.survey_sent_at).not.toBeNull();
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      "3050000001",
      expect.stringContaining("1 al 5"),
    );

    // Reabre la conversación para no afectar el resto de los tests de
    // este archivo, que reutilizan la misma conversación semilla.
    await adminPool.query(
      `UPDATE conversations SET status = 'open', closed_at = NULL WHERE id = $1`,
      [conversationId],
    );
  });

  it("resolver sobre un caso que todavía no está en_atencion devuelve 409", async () => {
    const { token } = await seedHandoff();
    const result = await resolverConversacion(token);
    expect(result.status).toBe(409);
  });

  it("una acción con token inválido devuelve 404", async () => {
    expect((await tomarConversacion("token-invalido")).status).toBe(404);
    expect((await resolverConversacion("token-invalido")).status).toBe(404);
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

  it("POST /asesor/:token/tomar redirige de vuelta a la vista", async () => {
    const { token } = await seedHandoff();

    const response = await app.inject({ method: "POST", url: `/asesor/${token}/tomar` });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`/asesor/${token}`);
  });
});
