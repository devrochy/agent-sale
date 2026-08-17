import pg from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ensureConnectionsFromEnv,
  findConnectionByExternalId,
  getConnection,
  getPrimaryConnection,
  invalidateConnectionsCache,
  listConnections,
  saveConnection,
  setConnectionActive,
  setPrimaryConnection,
  updateConnection,
} from "../../../../src/shared/db/connectionsDirectory.js";
import { pool as appPool } from "../../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

// Etiqueta única por archivo: `channel_connections` es, como `settings`, una
// tabla chica que varios tests podrían pisarse entre sí (vitest corre con
// fileParallelism:false pero sin truncado entre archivos). Todo lo que este
// archivo crea se borra por external_id en afterEach, y ningún caso afirma
// "hay exactamente N conexiones".
const EXTERNAL_IDS = [
  "whatsapp:+570000000001",
  "whatsapp:+570000000002",
  "test-meta-phone-id-0001",
  "test-meta-phone-id-0002",
  "test-meta-phone-id-0003",
  "test-ig-account-0001",
];

async function limpiar(): Promise<void> {
  await adminPool.query("DELETE FROM channel_connections WHERE external_id = ANY($1)", [
    EXTERNAL_IDS,
  ]);
  invalidateConnectionsCache();
}

afterEach(limpiar);

afterAll(async () => {
  await limpiar();
  await adminPool.end();
  await appPool.end();
});

describe("connectionsDirectory", () => {
  it("guarda y devuelve credenciales descifradas, sin exponerlas en el listado", async () => {
    const id = await saveConnection({
      channel: "whatsapp",
      provider: "twilio",
      label: "WhatsApp Test",
      externalId: EXTERNAL_IDS[0]!,
      displayAddress: EXTERNAL_IDS[0]!,
      credentials: { accountSid: "ACtest1234", authToken: "token-secreto" },
    });

    const resolved = await getConnection(id);
    expect(resolved?.credentials).toEqual({ accountSid: "ACtest1234", authToken: "token-secreto" });

    // En la columna vive cifrado, no en claro.
    const raw = await adminPool.query<{ credentials_encrypted: string }>(
      "SELECT credentials_encrypted FROM channel_connections WHERE id = $1",
      [id],
    );
    expect(raw.rows[0]!.credentials_encrypted).not.toContain("token-secreto");
    expect(raw.rows[0]!.credentials_encrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);

    // El listado del panel no debe traer credenciales ni siquiera cifradas.
    const listada = (await listConnections()).find((c) => c.id === id);
    expect(listada).toBeDefined();
    expect(JSON.stringify(listada)).not.toContain("token-secreto");
    expect(listada).not.toHaveProperty("credentials");
  });

  it("resuelve la conexión por clave de ruteo entrante", async () => {
    const id = await saveConnection({
      channel: "whatsapp",
      provider: "twilio",
      label: "WhatsApp Test",
      externalId: EXTERNAL_IDS[0]!,
      displayAddress: EXTERNAL_IDS[0]!,
      credentials: { accountSid: "ACtest1234", authToken: "t" },
    });

    expect((await findConnectionByExternalId("twilio", EXTERNAL_IDS[0]!))?.id).toBe(id);
    // La clave de ruteo es (provider, external_id): el mismo id bajo otro
    // proveedor no debe matchear.
    expect(await findConnectionByExternalId("meta", EXTERNAL_IDS[0]!)).toBeNull();
    expect(await findConnectionByExternalId("twilio", "no-existe")).toBeNull();
  });

  it("actualiza en vez de duplicar cuando se reguarda la misma clave de ruteo", async () => {
    const primero = await saveConnection({
      channel: "whatsapp",
      provider: "twilio",
      label: "Etiqueta vieja",
      externalId: EXTERNAL_IDS[0]!,
      displayAddress: EXTERNAL_IDS[0]!,
      credentials: { accountSid: "ACviejo", authToken: "viejo" },
    });
    const segundo = await saveConnection({
      channel: "whatsapp",
      provider: "twilio",
      label: "Etiqueta nueva",
      externalId: EXTERNAL_IDS[0]!,
      displayAddress: EXTERNAL_IDS[0]!,
      credentials: { accountSid: "ACnuevo", authToken: "nuevo" },
    });

    expect(segundo).toBe(primero);
    const resolved = await getConnection(primero);
    expect(resolved?.label).toBe("Etiqueta nueva");
    expect(resolved?.credentials.authToken).toBe("nuevo");
  });

  it("una credencial rotada se ve sin reiniciar el proceso (la caché se invalida al guardar)", async () => {
    const id = await saveConnection({
      channel: "whatsapp",
      provider: "twilio",
      label: "WhatsApp Test",
      externalId: EXTERNAL_IDS[0]!,
      displayAddress: EXTERNAL_IDS[0]!,
      credentials: { accountSid: "ACtest1234", authToken: "token-viejo" },
    });
    // Poblar la caché antes de rotar.
    expect((await getConnection(id))?.credentials.authToken).toBe("token-viejo");

    await saveConnection({
      channel: "whatsapp",
      provider: "twilio",
      label: "WhatsApp Test",
      externalId: EXTERNAL_IDS[0]!,
      displayAddress: EXTERNAL_IDS[0]!,
      credentials: { accountSid: "ACtest1234", authToken: "token-nuevo" },
    });

    expect((await getConnection(id))?.credentials.authToken).toBe("token-nuevo");
  });

  it("solo permite una conexión primary por canal", async () => {
    const primera = await saveConnection({
      channel: "whatsapp",
      provider: "twilio",
      label: "Primera",
      externalId: EXTERNAL_IDS[0]!,
      displayAddress: EXTERNAL_IDS[0]!,
      credentials: { accountSid: "AC1", authToken: "t" },
    });
    const segunda = await saveConnection({
      channel: "whatsapp",
      provider: "meta",
      label: "Segunda",
      externalId: EXTERNAL_IDS[2]!,
      displayAddress: "+57 300 000 0002",
      credentials: { accessToken: "t" },
    });

    await setPrimaryConnection(primera);
    expect((await getPrimaryConnection("whatsapp"))?.id).toBe(primera);

    // Mover la marca no puede dejar dos primarys: el índice único parcial de
    // la migración 0053 rechazaría el estado intermedio si no fuera atómico.
    await setPrimaryConnection(segunda);
    expect((await getPrimaryConnection("whatsapp"))?.id).toBe(segunda);

    const cuantas = await adminPool.query<{ count: string }>(
      "SELECT count(*) FROM channel_connections WHERE channel = 'whatsapp' AND is_primary AND external_id = ANY($1)",
      [EXTERNAL_IDS],
    );
    expect(cuantas.rows[0]!.count).toBe("1");
  });

  it("rechaza dos conexiones del mismo proveedor con la misma clave de ruteo", async () => {
    await saveConnection({
      channel: "whatsapp",
      provider: "twilio",
      label: "Primera",
      externalId: EXTERNAL_IDS[0]!,
      displayAddress: EXTERNAL_IDS[0]!,
      credentials: { accountSid: "AC1", authToken: "t" },
    });

    // Un INSERT crudo (sin el ON CONFLICT de saveConnection) debe chocar
    // contra UNIQUE(provider, external_id).
    await expect(
      adminPool.query(
        `INSERT INTO channel_connections (channel, provider, label, external_id, credentials_encrypted)
         VALUES ('whatsapp', 'twilio', 'Duplicada', $1, 'x')`,
        [EXTERNAL_IDS[0]!],
      ),
    ).rejects.toThrow();
  });

  it("permite dos conexiones del mismo canal y proveedor con claves de ruteo distintas", async () => {
    // Dos números de Twilio (ventas y soporte) es un caso legítimo — por eso
    // la unicidad es (provider, external_id) y no (channel, provider).
    const ventas = await saveConnection({
      channel: "whatsapp",
      provider: "twilio",
      label: "Ventas",
      externalId: EXTERNAL_IDS[0]!,
      displayAddress: EXTERNAL_IDS[0]!,
      credentials: { accountSid: "AC1", authToken: "t" },
    });
    const soporte = await saveConnection({
      channel: "whatsapp",
      provider: "twilio",
      label: "Soporte",
      externalId: EXTERNAL_IDS[1]!,
      displayAddress: EXTERNAL_IDS[1]!,
      credentials: { accountSid: "AC1", authToken: "t" },
    });

    expect(ventas).not.toBe(soporte);
  });

  it("desactivar no borra la conexión, solo la marca inactiva", async () => {
    const id = await saveConnection({
      channel: "whatsapp",
      provider: "twilio",
      label: "WhatsApp Test",
      externalId: EXTERNAL_IDS[0]!,
      displayAddress: EXTERNAL_IDS[0]!,
      credentials: { accountSid: "AC1", authToken: "t" },
    });
    expect((await getConnection(id))?.active).toBe(true);

    await setConnectionActive(id, false);
    expect((await getConnection(id))?.active).toBe(false);
  });

  it("ensureConnectionsFromEnv restaura la primary si el canal se quedó sin ninguna", async () => {
    await ensureConnectionsFromEnv();
    // Simula el estado en que quedaría el canal si se borrara o reasignara la
    // conexión que tenía la marca: sin primary, `sendToPrimary` lanzaría y se
    // caerían todas las notificaciones a administradores, en silencio.
    await adminPool.query("UPDATE channel_connections SET is_primary = false WHERE channel = 'whatsapp'");
    invalidateConnectionsCache();
    expect(await getPrimaryConnection("whatsapp")).toBeNull();

    await ensureConnectionsFromEnv();

    expect(await getPrimaryConnection("whatsapp")).not.toBeNull();
  });

  it("backfill: apunta a la primary las conversaciones que quedaron sin conexión", async () => {
    await ensureConnectionsFromEnv();
    const primary = await getPrimaryConnection("whatsapp");
    expect(primary).not.toBeNull();

    const customer = await adminPool.query<{ id: string }>(
      `INSERT INTO customers (external_id) VALUES ('whatsapp:+570000000777') RETURNING id`,
    );
    const customerId = customer.rows[0]!.id;
    const conversacion = await adminPool.query<{ id: string }>(
      `INSERT INTO conversations (customer_id, status, state, connection_id)
       VALUES ($1, 'open', '{}'::jsonb, NULL) RETURNING id`,
      [customerId],
    );
    const conversationId = conversacion.rows[0]!.id;

    try {
      await ensureConnectionsFromEnv();

      const despues = await adminPool.query<{ connection_id: string | null }>(
        "SELECT connection_id FROM conversations WHERE id = $1",
        [conversationId],
      );
      expect(despues.rows[0]!.connection_id).toBe(primary!.id);
    } finally {
      await adminPool.query("DELETE FROM conversations WHERE id = $1", [conversationId]);
      await adminPool.query("DELETE FROM customers WHERE id = $1", [customerId]);
    }
  });

  it("ensureConnectionsFromEnv es idempotente: correrla dos veces no duplica", async () => {
    await ensureConnectionsFromEnv();
    const despuesDeLaPrimera = await adminPool.query<{ count: string }>(
      "SELECT count(*) FROM channel_connections WHERE provider = 'twilio'",
    );

    await ensureConnectionsFromEnv();
    const despuesDeLaSegunda = await adminPool.query<{ count: string }>(
      "SELECT count(*) FROM channel_connections WHERE provider = 'twilio'",
    );

    expect(despuesDeLaSegunda.rows[0]!.count).toBe(despuesDeLaPrimera.rows[0]!.count);
  });

  it("cambiar la clave de ruteo actualiza la conexión en vez de crear otra", async () => {
    // El caso real: el admin migra a otro número de Meta y edita el Phone
    // Number ID. Con un upsert por (provider, external_id) la clave nueva no
    // choca con nada, así que insertaría una segunda conexión y dejaría la
    // vieja activa con las credenciales de antes — las respuestas seguirían
    // saliendo por el número anterior.
    const id = await saveConnection({
      channel: "whatsapp",
      provider: "meta",
      label: "WhatsApp · Meta",
      externalId: "test-meta-phone-id-0002",
      displayAddress: "+57 300 000 0002",
      credentials: { phoneNumberId: "test-meta-phone-id-0002", accessToken: "token-viejo" },
    });

    const actualizada = await updateConnection(id, {
      label: "WhatsApp · Meta",
      externalId: "test-meta-phone-id-0003",
      displayAddress: "+57 300 000 0003",
      credentials: { phoneNumberId: "test-meta-phone-id-0003", accessToken: "token-nuevo" },
    });

    expect(actualizada).toBe(true);
    // La misma fila, con la clave nueva: no quedó una huérfana con la vieja.
    const resuelta = await getConnection(id);
    expect(resuelta?.externalId).toBe("test-meta-phone-id-0003");
    expect(resuelta?.credentials.accessToken).toBe("token-nuevo");
    expect(await findConnectionByExternalId("meta", "test-meta-phone-id-0002")).toBeNull();
  });

  it("rechaza mover la clave de ruteo a una que ya tiene otra conexión del proveedor", async () => {
    const ocupante = await saveConnection({
      channel: "whatsapp",
      provider: "meta",
      label: "Meta A",
      externalId: "test-meta-phone-id-0002",
      displayAddress: null,
      credentials: { phoneNumberId: "test-meta-phone-id-0002" },
    });
    const otra = await saveConnection({
      channel: "whatsapp",
      provider: "meta",
      label: "Meta B",
      externalId: "test-meta-phone-id-0003",
      displayAddress: null,
      credentials: { phoneNumberId: "test-meta-phone-id-0003" },
    });

    const resultado = await updateConnection(otra, {
      label: "Meta B",
      externalId: "test-meta-phone-id-0002",
      displayAddress: null,
      credentials: { phoneNumberId: "test-meta-phone-id-0002" },
    });

    // Choque legítimo, no excepción: el panel tiene que poder explicarlo.
    expect(resultado).toBe(false);
    expect((await getConnection(otra))?.externalId).toBe("test-meta-phone-id-0003");
    expect((await getConnection(ocupante))?.externalId).toBe("test-meta-phone-id-0002");
  });

  it("la primera conexión de un canal queda como primary aunque nadie la marque", async () => {
    // Un despliegue solo-Meta no pasa nunca por ensureConnectionsFromEnv (corta
    // sin credenciales de Twilio en el entorno) y la fila nace is_primary=false.
    // Sin primary, sendToPrimary lanza y con él todas las notificaciones a
    // administradores. Se usa 'instagram' porque no tiene conexiones en ningún
    // entorno: en 'whatsapp' ya suele haber una primary y no probaría nada.
    expect(await getPrimaryConnection("instagram")).toBeNull();

    const id = await saveConnection({
      channel: "instagram",
      provider: "meta",
      label: "Instagram · Meta",
      externalId: "test-ig-account-0001",
      displayAddress: "@formotos",
      credentials: { accessToken: "token" },
    });

    expect((await getPrimaryConnection("instagram"))?.id).toBe(id);
  });
});
