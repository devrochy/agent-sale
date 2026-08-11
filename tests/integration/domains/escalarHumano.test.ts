import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
}));

import { sendWhatsAppMessage } from "../../../src/gateway/sendMessage.js";
import { createAdmin, updateAdminPermissions } from "../../../src/admin/auth/adminsDirectory.js";
import { hashPassword } from "../../../src/admin/auth/passwordHash.js";
import { escalarHumano } from "../../../src/domains/escalation/escalarHumano.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let conversationA: string;
let customerAId: string;

beforeAll(async () => {
  const customerA = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id) VALUES ('3010000001') RETURNING id`,
  );
  customerAId = customerA.rows[0]!.id;
  const conversationARes = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerAId],
  );
  conversationA = conversationARes.rows[0]!.id;
});

afterEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
});

afterAll(async () => {
  // Los admins/handoff_tokens creados dentro de cada it() ya se borran ahí
  // mismo — esto solo cubre handoff_queue (creado en casi todos los tests)
  // y la conversación/cliente semilla.
  await adminPool.query(
    `DELETE FROM handoff_tokens WHERE handoff_id IN (SELECT id FROM handoff_queue WHERE conversation_id = $1)`,
    [conversationA],
  );
  await adminPool.query(`DELETE FROM handoff_queue WHERE conversation_id = $1`, [conversationA]);
  await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationA]);
  await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerAId]);
  await adminPool.end();
  await appPool.end();
});

async function seedAdminConTickets(username: string, phone: string): Promise<string> {
  const passwordHash = await hashPassword("clave-de-prueba-escalarhumano");
  const adminId = await createAdmin(username, `${username}@formotos-test.com`, passwordHash, "colaborador", phone);
  await updateAdminPermissions(adminId, {
    recibeReporteDiario: false,
    recibeTickets: true,
    recibeNotificacionPagos: false,
  });
  return adminId;
}

async function deleteAdmin(adminId: string): Promise<void> {
  await adminPool.query(`DELETE FROM admin_permissions WHERE admin_id = $1`, [adminId]);
  await adminPool.query(`DELETE FROM admins WHERE id = $1`, [adminId]);
}

describe("escalarHumano", () => {
  it("crea un registro en handoff_queue con status queued", async () => {
    const result = await escalarHumano(conversationA, {
      reason: "queja",
      summary: "El cliente está molesto por un retraso en su pedido.",
    });

    expect(result.status).toBe("queued");
    expect(result.handoff_id).toBeTruthy();

    const row = await adminPool.query(`SELECT reason, summary FROM handoff_queue WHERE id = $1`, [
      result.handoff_id,
    ]);
    expect(row.rows[0]).toMatchObject({
      reason: "queja",
      summary: "El cliente está molesto por un retraso en su pedido.",
    });
  });

  it("falla si la conversación no existe (FK)", async () => {
    await expect(
      escalarHumano("00000000-0000-0000-0000-000000000000", {
        reason: "queja",
        summary: "x",
      }),
    ).rejects.toThrow();
  });

  it("notifica por WhatsApp a los admins con recibeTickets, con un enlace a la vista del asesor", async () => {
    const adminId = await seedAdminConTickets("ticket-test", "whatsapp:+573009999999");

    const result = await escalarHumano(conversationA, {
      reason: "monto_alto",
      summary: "Cotización grande.",
    });

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      "whatsapp:+573009999999",
      expect.stringMatching(/monto_alto[\s\S]*\/asesor\//),
    );

    const token = await adminPool.query(`SELECT handoff_id FROM handoff_tokens WHERE handoff_id = $1`, [
      result.handoff_id,
    ]);
    expect(token.rows[0]).toBeTruthy();

    await deleteAdmin(adminId);
  });

  it("no falla si no hay ningún admin con recibeTickets ni teléfono legado configurado", async () => {
    // `settings.report_recipient_phone` es un singleton persistente (ver
    // getReportRecipient()) — en una base de datos recién migrada (CI) puede
    // no existir ninguna fila todavía, a diferencia de una base de
    // desarrollo con uso previo, así que esta prueba crea la suya propia si
    // hace falta (mismo patrón que el resto de los tests de integración) en
    // vez de asumir que otra prueba ya la dejó creada.
    const previous = await adminPool.query<{ id: string; report_recipient_phone: string | null }>(
      `SELECT id, report_recipient_phone FROM settings LIMIT 1`,
    );
    const settingsId =
      previous.rows[0]?.id ??
      (
        await adminPool.query<{ id: string }>(
          `INSERT INTO settings (name) VALUES ('Escalar Humano Test') RETURNING id`,
        )
      ).rows[0]!.id;
    const previousPhone = previous.rows[0]?.report_recipient_phone ?? null;
    const createdBySelf = previous.rows.length === 0;
    await adminPool.query(`UPDATE settings SET report_recipient_phone = NULL WHERE id = $1`, [settingsId]);

    try {
      await expect(
        escalarHumano(conversationA, { reason: "queja", summary: "sin asesores" }),
      ).resolves.toMatchObject({ status: "queued" });
      expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    } finally {
      if (createdBySelf) {
        await adminPool.query(`DELETE FROM settings WHERE id = $1`, [settingsId]);
      } else {
        await adminPool.query(`UPDATE settings SET report_recipient_phone = $1 WHERE id = $2`, [
          previousPhone,
          settingsId,
        ]);
      }
    }
  });

  it("el registro se crea igual aunque falle el envío de la notificación (best-effort)", async () => {
    const adminId = await seedAdminConTickets("ticket-test-2", "whatsapp:+573008888888");
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("Twilio no disponible"));

    const result = await escalarHumano(conversationA, {
      reason: "queja",
      summary: "notificación que va a fallar",
    });

    expect(result.status).toBe("queued");

    await deleteAdmin(adminId);
  });
});
