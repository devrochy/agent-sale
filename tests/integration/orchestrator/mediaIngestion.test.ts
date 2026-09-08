import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendToConversation: vi.fn(),
  getWhatsAppMessageStatus: vi.fn(),
}));
vi.mock("../../../src/gateway/channels/meta/media.js", () => ({
  downloadMedia: vi.fn(),
}));
vi.mock("../../../src/media/transcribirAudio.js", () => ({
  transcribirAudio: vi.fn(),
}));
vi.mock("../../../src/payments/ocrComprobante.js", () => ({
  analizarComprobante: vi.fn(),
}));
vi.mock("../../../src/domains/catalog/describirImagenProducto.js", () => ({
  describirImagenProducto: vi.fn(),
}));

import { sendToConversation } from "../../../src/gateway/sendMessage.js";
import { downloadMedia } from "../../../src/gateway/channels/meta/media.js";
import { transcribirAudio } from "../../../src/media/transcribirAudio.js";
import { analizarComprobante } from "../../../src/payments/ocrComprobante.js";
import { describirImagenProducto } from "../../../src/domains/catalog/describirImagenProducto.js";
import { crearPedido } from "../../../src/domains/commerce/crearPedido.js";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import { procesarMediaEntrante } from "../../../src/orchestrator/mediaIngestion.js";
import type { InboundMessage } from "../../../src/gateway/queue.js";
import { invalidateConnectionsCache, saveConnection } from "../../../src/shared/db/connectionsDirectory.js";
import { saveTransferAccounts, type TransferAccount } from "../../../src/shared/db/settingsDirectory.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { deleteProduct, seedProduct } from "../../helpers/seedCatalog.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const PHONE = `whatsapp:+5731${Date.now().toString().slice(-7)}`;
const CUENTA_TIENDA: TransferAccount = {
  entity: "Bancolombia",
  accountType: "Ahorros",
  accountNumber: "555-666777-88",
  holderName: "ForMotos SAS",
  holderDocument: "",
  active: true,
};

const customerData = {
  address: "Calle 5 # 6-78",
  id_document: "555666777",
  full_name: "Cliente Media",
  save_permanently: false,
};

const entryLogger = { info: vi.fn(), warn: vi.fn() };

let connectionId: string;
let customerId: string;
let productId: string;
let variantId: string;

beforeAll(async () => {
  connectionId = await saveConnection({
    channel: "whatsapp",
    provider: "meta",
    label: "WhatsApp Media Test · Meta",
    externalId: `media-test-${Date.now()}`,
    displayAddress: "+57 300 555 6677",
    credentials: {
      phoneNumberId: "media-test-phone",
      wabaId: "waba-media-test",
      accessToken: "token-media-test",
      appSecret: "secreto-media-test",
      verifyToken: "verify-media-test",
    },
  });

  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id) VALUES ($1) RETURNING id`,
    [PHONE],
  );
  customerId = customer.rows[0]!.id;

  const product = await seedProduct(adminPool, {
    sku: `MEDIA-${Date.now()}`,
    name: "Casco media",
    price: 150000,
    stock: 10,
  });
  productId = product.productId;
  variantId = product.variantId;
});

afterEach(() => {
  vi.mocked(sendToConversation).mockReset();
  vi.mocked(downloadMedia).mockReset();
  vi.mocked(transcribirAudio).mockReset();
  vi.mocked(analizarComprobante).mockReset();
  vi.mocked(describirImagenProducto).mockReset();
  entryLogger.info.mockReset();
  entryLogger.warn.mockReset();
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM payment_receipts WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`, [customerId]);
  await adminPool.query(`DELETE FROM inbound_media WHERE conversation_id IN (SELECT id FROM conversations WHERE customer_id = $1)`, [customerId]);
  await adminPool.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`, [customerId]);
  await adminPool.query(`DELETE FROM orders WHERE customer_id = $1`, [customerId]);
  await adminPool.query(`DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE customer_id = $1)`, [customerId]);
  await adminPool.query(`DELETE FROM quotes WHERE customer_id = $1`, [customerId]);
  await adminPool.query(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE customer_id = $1)`, [customerId]);
  await adminPool.query(`DELETE FROM conversations WHERE customer_id = $1`, [customerId]);
  await deleteProduct(adminPool, productId);
  await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  await adminPool.query(`DELETE FROM channel_connections WHERE id = $1`, [connectionId]);
  invalidateConnectionsCache();
  await saveTransferAccounts([]);
  await adminPool.end();
  await appPool.end();
});

function nuevoMensaje(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageSid: `sid-media-${Date.now()}-${Math.random()}`,
    customerExternalId: PHONE,
    customerName: "Cliente Media",
    body: "",
    receivedAt: new Date().toISOString(),
    connectionId,
    channel: "whatsapp",
    ...overrides,
  };
}

describe("procesarMediaEntrante — audio", () => {
  it("transcribe bien -> continuar_como_texto con el transcript, y guarda el media en inbound_media", async () => {
    vi.mocked(downloadMedia).mockResolvedValueOnce({ buffer: Buffer.from("audio"), mimeType: "audio/ogg" });
    vi.mocked(transcribirAudio).mockResolvedValueOnce("Hola, buscaba un casco talla M");

    const mensaje = nuevoMensaje({ media: { type: "audio", mediaId: "media-audio-1", mimeType: "audio/ogg" } });
    const resultado = await procesarMediaEntrante(mensaje, { connectionId, channel: "whatsapp" }, entryLogger);

    expect(resultado).toEqual({ kind: "continuar_como_texto", texto: "Hola, buscaba un casco talla M" });
    expect(sendToConversation).not.toHaveBeenCalled();

    const media = await adminPool.query(`SELECT kind, mime_type FROM inbound_media WHERE conversation_id IN (SELECT id FROM conversations WHERE customer_id = $1) ORDER BY created_at DESC LIMIT 1`, [customerId]);
    expect(media.rows[0]).toMatchObject({ kind: "audio", mime_type: "audio/ogg" });
  });

  it("Whisper no entiende nada -> procesado_completo, avisa al cliente y dejar rastro en la conversación", async () => {
    vi.mocked(downloadMedia).mockResolvedValueOnce({ buffer: Buffer.from("ruido"), mimeType: "audio/ogg" });
    vi.mocked(transcribirAudio).mockResolvedValueOnce(null);

    const mensaje = nuevoMensaje({ media: { type: "audio", mediaId: "media-audio-2", mimeType: "audio/ogg" } });
    const resultado = await procesarMediaEntrante(mensaje, { connectionId, channel: "whatsapp" }, entryLogger);

    expect(resultado).toEqual({ kind: "procesado_completo" });
    expect(sendToConversation).toHaveBeenCalledTimes(1);
    const [, texto] = vi.mocked(sendToConversation).mock.calls[0]!;
    expect(texto).toContain("No pudimos entender el audio");
  });

  it("sin connectionId en el origin -> no_manejado, sin llamar downloadMedia", async () => {
    const mensaje = nuevoMensaje({ media: { type: "audio", mediaId: "media-audio-3", mimeType: "audio/ogg" } });
    const resultado = await procesarMediaEntrante(mensaje, { channel: "whatsapp" }, entryLogger);

    expect(resultado).toEqual({ kind: "no_manejado" });
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it("un reintento con el MISMO messageSid reusa la transcripción ya pagada, no vuelve a llamar a Whisper", async () => {
    vi.mocked(downloadMedia).mockResolvedValue({ buffer: Buffer.from("audio"), mimeType: "audio/ogg" });
    vi.mocked(transcribirAudio).mockResolvedValueOnce("Quiero unos guantes talla L");
    const messageSid = `sid-media-cache-${Date.now()}`;

    const mensaje = nuevoMensaje({ messageSid, media: { type: "audio", mediaId: "media-audio-4", mimeType: "audio/ogg" } });
    const primero = await procesarMediaEntrante(mensaje, { connectionId, channel: "whatsapp" }, entryLogger);
    // Mismo mensaje otra vez (simula un reintento de la cola).
    const segundo = await procesarMediaEntrante(mensaje, { connectionId, channel: "whatsapp" }, entryLogger);

    expect(primero).toEqual({ kind: "continuar_como_texto", texto: "Quiero unos guantes talla L" });
    expect(segundo).toEqual({ kind: "continuar_como_texto", texto: "Quiero unos guantes talla L" });
    expect(transcribirAudio).toHaveBeenCalledTimes(1); // no 2 — el segundo intento reusó la cache
  });
});

describe("procesarMediaEntrante — imagen", () => {
  async function nuevoPedidoPorTransferencia(): Promise<string> {
    const quote = await generarCotizacion(
      (await adminPool.query<{ id: string }>(`INSERT INTO conversations (customer_id, connection_id, channel) VALUES ($1, $2, 'whatsapp') RETURNING id`, [customerId, connectionId])).rows[0]!.id,
      customerId,
      { items: [{ variant_id: variantId, quantity: 1 }] },
    );
    const created = await crearPedido(
      `sid-media-pedido-${Date.now()}-${Math.random()}`,
      { quote_id: quote.quote_id, payment_method: "transferencia", delivery_method: "domicilio", customer_data: customerData },
      1000000,
    );
    return created.order_id!;
  }

  it("sin pedido pendiente por transferencia y la foto muestra un producto -> continuar_como_texto con la descripción", async () => {
    vi.mocked(downloadMedia).mockResolvedValueOnce({ buffer: Buffer.from("foto-producto"), mimeType: "image/jpeg" });
    vi.mocked(describirImagenProducto).mockResolvedValueOnce("casco integral negro con visor ahumado");

    const mensaje = nuevoMensaje({ media: { type: "image", mediaId: "media-img-1", mimeType: "image/jpeg" } });
    // Este cliente no tiene ningún pedido por transferencia pendiente en este describe todavía.
    const resultado = await procesarMediaEntrante(mensaje, { connectionId, channel: "whatsapp" }, entryLogger);

    expect(resultado).toEqual({
      kind: "continuar_como_texto",
      texto: "[Foto de producto] El cliente mandó una foto. Descripción automática: casco integral negro con visor ahumado",
    });
    expect(sendToConversation).not.toHaveBeenCalled();

    const media = await adminPool.query(`SELECT kind FROM inbound_media WHERE conversation_id IN (SELECT id FROM conversations WHERE customer_id = $1) ORDER BY created_at DESC LIMIT 1`, [customerId]);
    expect(media.rows[0]).toMatchObject({ kind: "image" });
  });

  it("sin pedido pendiente y la foto no muestra ningún producto reconocible -> procesado_completo, pide más detalle", async () => {
    vi.mocked(downloadMedia).mockResolvedValueOnce({ buffer: Buffer.from("foto-rara"), mimeType: "image/jpeg" });
    vi.mocked(describirImagenProducto).mockResolvedValueOnce(null);

    const mensaje = nuevoMensaje({ media: { type: "image", mediaId: "media-img-1b", mimeType: "image/jpeg" } });
    const resultado = await procesarMediaEntrante(mensaje, { connectionId, channel: "whatsapp" }, entryLogger);

    expect(resultado).toEqual({ kind: "procesado_completo" });
    expect(sendToConversation).toHaveBeenCalledTimes(1);
    const [, texto] = vi.mocked(sendToConversation).mock.calls[0]!;
    expect(texto).toContain("No pudimos reconocer bien qué buscás en esa foto");
  });

  it("con pedido pendiente por transferencia -> procesado_completo, corre todo el flujo de OCR", async () => {
    await saveTransferAccounts([CUENTA_TIENDA]);
    await nuevoPedidoPorTransferencia();
    vi.mocked(sendToConversation).mockClear(); // limpia el auto-envío de datos de transferencia de crear_pedido

    vi.mocked(downloadMedia).mockResolvedValueOnce({ buffer: Buffer.from("comprobante"), mimeType: "image/jpeg" });
    vi.mocked(analizarComprobante).mockResolvedValueOnce({ monto: 150000, cuentaDestino: "555-666777-88" });

    const mensaje = nuevoMensaje({ media: { type: "image", mediaId: "media-img-2", mimeType: "image/jpeg" } });
    const resultado = await procesarMediaEntrante(mensaje, { connectionId, channel: "whatsapp" }, entryLogger);

    expect(resultado).toEqual({ kind: "procesado_completo" });
    // El ruteo es determinístico: con un pedido esperando comprobante, la
    // foto SIEMPRE se trata como comprobante — nunca se le pregunta a la
    // visión "qué producto es esto".
    expect(describirImagenProducto).not.toHaveBeenCalled();
  });
});
