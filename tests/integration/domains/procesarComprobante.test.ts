import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendToConversation: vi.fn(),
  getWhatsAppMessageStatus: vi.fn(),
}));
vi.mock("../../../src/payments/ocrComprobante.js", () => ({
  analizarComprobante: vi.fn(),
}));

import { sendToConversation, sendWhatsAppMessage } from "../../../src/gateway/sendMessage.js";
import { analizarComprobante } from "../../../src/payments/ocrComprobante.js";
import { crearPedido } from "../../../src/domains/commerce/crearPedido.js";
import { generarCotizacion } from "../../../src/domains/commerce/generarCotizacion.js";
import {
  aprobarComprobanteManual,
  buscarPedidoPendienteTransferencia,
  procesarComprobante,
  rechazarComprobanteManual,
} from "../../../src/domains/commerce/procesarComprobante.js";
import { guardarMediaEntrante } from "../../../src/shared/db/inboundMediaDirectory.js";
import {
  listReceiptsPendientesDeRevision,
  registrarPaymentReceipt,
} from "../../../src/shared/db/paymentReceiptsDirectory.js";
import {
  saveReportRecipient,
  saveTransferAccounts,
  type TransferAccount,
} from "../../../src/shared/db/settingsDirectory.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";
import { deleteProduct, seedProduct } from "../../helpers/seedCatalog.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

const PHONE = `whatsapp:+5730000${Date.now().toString().slice(-6)}`;
const CUENTA_TIENDA: TransferAccount = {
  entity: "Bancolombia",
  accountType: "Ahorros",
  accountNumber: "111-222333-44",
  holderName: "ForMotos SAS",
  holderDocument: "",
  active: true,
};

const customerData = {
  address: "Calle 1 # 2-34",
  id_document: "123456789",
  full_name: "Cliente Comprobante",
  save_permanently: false,
};

let conversationId: string;
let customerId: string;
let productId: string;
let variantId: string;

beforeAll(async () => {
  const customer = await adminPool.query<{ id: string }>(
    `INSERT INTO customers (external_id) VALUES ($1) RETURNING id`,
    [PHONE],
  );
  customerId = customer.rows[0]!.id;
  const conversation = await adminPool.query<{ id: string }>(
    `INSERT INTO conversations (customer_id) VALUES ($1) RETURNING id`,
    [customerId],
  );
  conversationId = conversation.rows[0]!.id;

  const product = await seedProduct(adminPool, {
    sku: `COMPROBANTE-${Date.now()}`,
    name: "Casco comprobante",
    price: 200000,
    stock: 20,
  });
  productId = product.productId;
  variantId = product.variantId;

  await saveReportRecipient("whatsapp:+573000000999");
});

afterEach(() => {
  vi.mocked(sendToConversation).mockReset();
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(analizarComprobante).mockReset();
});

afterAll(async () => {
  await adminPool.query(`DELETE FROM payment_receipts WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = $1)`, [conversationId]);
  await adminPool.query(`DELETE FROM inbound_media WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE conversation_id = $1)`, [conversationId]);
  await adminPool.query(`DELETE FROM orders WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE conversation_id = $1)`, [conversationId]);
  await adminPool.query(`DELETE FROM quotes WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM messages WHERE conversation_id = $1`, [conversationId]);
  await adminPool.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
  await deleteProduct(adminPool, productId);
  await adminPool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  await saveTransferAccounts([]);
  await saveReportRecipient(null);
  await adminPool.end();
  await appPool.end();
});

/** Un pedido nuevo por transferencia (nace en payment_status='pendiente') + un media entrante ya guardado, listos para procesarComprobante. */
async function nuevoPedidoConMedia(): Promise<{ orderId: string; inboundMediaId: string }> {
  const quote = await generarCotizacion(conversationId, customerId, {
    items: [{ variant_id: variantId, quantity: 1 }],
  });
  const created = await crearPedido(
    `sid-comprobante-${Date.now()}-${Math.random()}`,
    {
      quote_id: quote.quote_id,
      payment_method: "transferencia",
      delivery_method: "domicilio",
      customer_data: customerData,
    },
    1000000,
  );
  const orderId = created.order_id!;
  const inboundMediaId = await guardarMediaEntrante({
    conversationId,
    kind: "image",
    mimeType: "image/jpeg",
    buffer: Buffer.from("fake-comprobante"),
  });
  // crear_pedido con "transferencia" YA manda los datos de la cuenta apenas
  // se confirma el pedido (ver crearPedido.ts) — eso también pasa por
  // sendToConversation, así que se limpia acá para que cada test empiece
  // limpio y solo vea las llamadas que hace procesarComprobante.
  vi.mocked(sendToConversation).mockClear();
  return { orderId, inboundMediaId };
}

describe("crearPedido con transferencia", () => {
  it("nace en payment_status='pendiente' (no 'pagado') — antes nadie lo revisaba nunca", async () => {
    const { orderId } = await nuevoPedidoConMedia();
    const row = await adminPool.query<{ payment_status: string }>(`SELECT payment_status FROM orders WHERE id = $1`, [orderId]);
    expect(row.rows[0]!.payment_status).toBe("pendiente");
  });
});

describe("buscarPedidoPendienteTransferencia", () => {
  it("encuentra el pedido abierto y pendiente por transferencia del cliente", async () => {
    const { orderId } = await nuevoPedidoConMedia();
    const encontrado = await buscarPedidoPendienteTransferencia(customerId);
    expect(encontrado?.orderId).toBe(orderId);
  });
});

describe("procesarComprobante", () => {
  it("monto y cuenta coinciden -> aprueba el pago", async () => {
    await saveTransferAccounts([CUENTA_TIENDA]);
    const { orderId, inboundMediaId } = await nuevoPedidoConMedia();
    vi.mocked(analizarComprobante).mockResolvedValueOnce({ monto: 200000, cuentaDestino: "111-222333-44" });

    const resultado = await procesarComprobante({
      orderId,
      inboundMediaId,
      messageSid: `wamid-comprobante-aprobado-${Date.now()}`,
      buffer: Buffer.from("x"),
      mimeType: "image/jpeg",
    });

    expect(resultado).toBe("aprobado");
    const row = await adminPool.query<{ payment_status: string }>(`SELECT payment_status FROM orders WHERE id = $1`, [orderId]);
    expect(row.rows[0]!.payment_status).toBe("pagado");
  });

  it("el monto no coincide -> rechaza automático, el pedido sigue pendiente (no queda trabado)", async () => {
    await saveTransferAccounts([CUENTA_TIENDA]);
    const { orderId, inboundMediaId } = await nuevoPedidoConMedia();
    vi.mocked(analizarComprobante).mockResolvedValueOnce({ monto: 50000, cuentaDestino: "111-222333-44" });

    const resultado = await procesarComprobante({
      orderId,
      inboundMediaId,
      messageSid: `wamid-comprobante-monto-${Date.now()}`,
      buffer: Buffer.from("x"),
      mimeType: "image/jpeg",
    });

    expect(resultado).toBe("rechazado_datos");
    expect(sendToConversation).toHaveBeenCalledTimes(1);
    const [, texto] = vi.mocked(sendToConversation).mock.calls[0]!;
    expect(texto).toContain("no coincide con el total del pedido");
    const row = await adminPool.query<{ payment_status: string }>(`SELECT payment_status FROM orders WHERE id = $1`, [orderId]);
    expect(row.rows[0]!.payment_status).toBe("pendiente");
  });

  it("la cuenta no coincide con ninguna cuenta de la tienda -> rechaza automático", async () => {
    await saveTransferAccounts([CUENTA_TIENDA]);
    const { orderId, inboundMediaId } = await nuevoPedidoConMedia();
    vi.mocked(analizarComprobante).mockResolvedValueOnce({ monto: 200000, cuentaDestino: "999-888777-66" });

    const resultado = await procesarComprobante({
      orderId,
      inboundMediaId,
      messageSid: `wamid-comprobante-cuenta-${Date.now()}`,
      buffer: Buffer.from("x"),
      mimeType: "image/jpeg",
    });

    expect(resultado).toBe("rechazado_datos");
    const [, texto] = vi.mocked(sendToConversation).mock.calls[0]!;
    expect(texto).toContain("número de cuenta no coincide");
  });

  it("imagen ilegible (primer intento) -> pide otra foto, sin cambiar el estado", async () => {
    const { orderId, inboundMediaId } = await nuevoPedidoConMedia();
    vi.mocked(analizarComprobante).mockResolvedValueOnce({ monto: null, cuentaDestino: null });

    const resultado = await procesarComprobante({
      orderId,
      inboundMediaId,
      messageSid: `wamid-comprobante-ilegible-${Date.now()}`,
      buffer: Buffer.from("x"),
      mimeType: "image/jpeg",
    });

    expect(resultado).toBe("pedir_otra_foto");
    const [, texto] = vi.mocked(sendToConversation).mock.calls[0]!;
    expect(texto).toContain("No pudimos leer bien la imagen");
    const row = await adminPool.query<{ payment_status: string; comprobante_intentos: number }>(
      `SELECT payment_status, comprobante_intentos FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(row.rows[0]!.payment_status).toBe("pendiente");
    expect(row.rows[0]!.comprobante_intentos).toBe(1);
  });

  it("tras agotar los reintentos -> escala a un admin y queda en payment_receipts como pendiente_revision", async () => {
    const { orderId, inboundMediaId } = await nuevoPedidoConMedia();
    vi.mocked(analizarComprobante).mockResolvedValue({ monto: null, cuentaDestino: null });

    // 2 intentos fallidos primero (no escalan todavía, LIMITE_INTENTOS=2) —
    // 3 fotos DISTINTAS del cliente (no reintentos de la cola sobre la
    // misma), por eso cada una lleva su propio messageSid.
    await procesarComprobante({
      orderId,
      inboundMediaId,
      messageSid: `wamid-comprobante-escala-1-${Date.now()}`,
      buffer: Buffer.from("x"),
      mimeType: "image/jpeg",
    });
    await procesarComprobante({
      orderId,
      inboundMediaId,
      messageSid: `wamid-comprobante-escala-2-${Date.now()}`,
      buffer: Buffer.from("x"),
      mimeType: "image/jpeg",
    });
    vi.mocked(sendToConversation).mockClear();
    vi.mocked(sendWhatsAppMessage).mockClear();

    // El 3ro ya supera el límite -> escala.
    const resultado = await procesarComprobante({
      orderId,
      inboundMediaId,
      messageSid: `wamid-comprobante-escala-3-${Date.now()}`,
      buffer: Buffer.from("x"),
      mimeType: "image/jpeg",
    });

    expect(resultado).toBe("escalado");
    expect(sendToConversation).toHaveBeenCalledTimes(1);
    // El destinatario real depende de qué admins con "recibeNotificacionPagos"
    // existan en esta base (si hay alguno con teléfono, gana sobre el
    // fallback de report_recipient_phone que configuró este test — ver
    // resolveNotificationRecipients) — por eso no se afirma un número
    // puntual, solo que el aviso best-effort se intentó mandar.
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);

    const pendientes = await listReceiptsPendientesDeRevision();
    expect(pendientes.some((r) => r.orderId === orderId)).toBe(true);
  });

  it("un segundo comprobante válido sobre un pedido ya aprobado no duplica el registro (marcarPagoAprobado ya no está pendiente)", async () => {
    await saveTransferAccounts([CUENTA_TIENDA]);
    const { orderId, inboundMediaId } = await nuevoPedidoConMedia();
    vi.mocked(analizarComprobante).mockResolvedValue({ monto: 200000, cuentaDestino: "111-222333-44" });

    const primero = await procesarComprobante({
      orderId,
      inboundMediaId,
      messageSid: `wamid-comprobante-dup-1-${Date.now()}`,
      buffer: Buffer.from("x"),
      mimeType: "image/jpeg",
    });
    const segundo = await procesarComprobante({
      orderId,
      inboundMediaId,
      messageSid: `wamid-comprobante-dup-2-${Date.now()}`, // otra foto, no un reintento del mismo mensaje
      buffer: Buffer.from("x"),
      mimeType: "image/jpeg",
    });

    expect(primero).toBe("aprobado");
    expect(segundo).toBe("aprobado"); // no revienta ni lo reporta como error, simplemente no repite el trabajo
    const receipts = await adminPool.query<{ resultado: string }>(
      `SELECT resultado FROM payment_receipts WHERE order_id = $1 AND resultado = 'aprobado_auto'`,
      [orderId],
    );
    expect(receipts.rowCount).toBe(1); // no dos — antes del fix quedaban dos filas y se avisaba "pago aprobado" dos veces
  });

  it("si la llamada de OCR falla de verdad (no 'no se pudo leer'), escala directo y avisa al cliente", async () => {
    const { orderId, inboundMediaId } = await nuevoPedidoConMedia();
    vi.mocked(analizarComprobante).mockRejectedValueOnce(new Error("Anthropic devolvió 500"));

    const resultado = await procesarComprobante({
      orderId,
      inboundMediaId,
      messageSid: `wamid-comprobante-error-ocr-${Date.now()}`,
      buffer: Buffer.from("x"),
      mimeType: "image/jpeg",
    });

    expect(resultado).toBe("error_tecnico");
    expect(sendToConversation).toHaveBeenCalledTimes(1); // antes: nada, el cliente no se enteraba
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1); // se notifica al admin igual que un escalado normal
    const pendientes = await listReceiptsPendientesDeRevision();
    expect(pendientes.some((r) => r.orderId === orderId)).toBe(true);
  });

  it("un reintento con el MISMO messageSid reusa el resultado de OCR ya pagado, no vuelve a llamar a Claude", async () => {
    await saveTransferAccounts([CUENTA_TIENDA]);
    const { orderId, inboundMediaId } = await nuevoPedidoConMedia();
    vi.mocked(analizarComprobante).mockResolvedValueOnce({ monto: 200000, cuentaDestino: "111-222333-44" });
    const messageSid = `wamid-comprobante-cache-${Date.now()}`;

    await procesarComprobante({ orderId, inboundMediaId, messageSid, buffer: Buffer.from("x"), mimeType: "image/jpeg" });
    // Segundo "intento" del mismo mensaje (simula un reintento de la cola
    // tras un fallo posterior al OCR) — mismo messageSid a propósito.
    const segundo = await procesarComprobante({
      orderId,
      inboundMediaId,
      messageSid,
      buffer: Buffer.from("x"),
      mimeType: "image/jpeg",
    });

    expect(segundo).toBe("aprobado");
    expect(analizarComprobante).toHaveBeenCalledTimes(1); // no 2 — el segundo intento reusó la cache
  });
});

describe("aprobarComprobanteManual / rechazarComprobanteManual", () => {
  it("aprueba a mano un comprobante escalado y lo marca en el receipt correcto", async () => {
    const { orderId, inboundMediaId } = await nuevoPedidoConMedia();
    const receiptId = await registrarPaymentReceipt({
      orderId,
      inboundMediaId,
      ocrMonto: null,
      ocrCuenta: null,
      resultado: "pendiente_revision",
    });

    const resultado = await aprobarComprobanteManual(orderId, receiptId, "devlocal");

    expect(resultado).toBe(true);
    const row = await adminPool.query<{ payment_status: string }>(`SELECT payment_status FROM orders WHERE id = $1`, [orderId]);
    expect(row.rows[0]!.payment_status).toBe("pagado");
    const receipt = await adminPool.query<{ resultado: string }>(`SELECT resultado FROM payment_receipts WHERE id = $1`, [receiptId]);
    expect(receipt.rows[0]!.resultado).toBe("aprobado_admin");
  });

  it("rechaza a mano un comprobante escalado y marca el pedido como rechazado", async () => {
    const { orderId, inboundMediaId } = await nuevoPedidoConMedia();
    const receiptId = await registrarPaymentReceipt({
      orderId,
      inboundMediaId,
      ocrMonto: null,
      ocrCuenta: null,
      resultado: "pendiente_revision",
    });

    const resultado = await rechazarComprobanteManual(orderId, receiptId, "devlocal");

    expect(resultado).toBe(true);
    const row = await adminPool.query<{ payment_status: string }>(`SELECT payment_status FROM orders WHERE id = $1`, [orderId]);
    expect(row.rows[0]!.payment_status).toBe("rechazado");
  });

  it("no aprueba si el receiptId no pertenece a ese orderId (formulario desincronizado)", async () => {
    const { orderId: orderId1, inboundMediaId } = await nuevoPedidoConMedia();
    const { orderId: orderId2 } = await nuevoPedidoConMedia();
    const receiptDeOtroPedido = await registrarPaymentReceipt({
      orderId: orderId2,
      inboundMediaId,
      ocrMonto: null,
      ocrCuenta: null,
      resultado: "pendiente_revision",
    });

    const resultado = await aprobarComprobanteManual(orderId1, receiptDeOtroPedido, "devlocal");

    expect(resultado).toBe(false);
    const row = await adminPool.query<{ payment_status: string }>(`SELECT payment_status FROM orders WHERE id = $1`, [orderId1]);
    expect(row.rows[0]!.payment_status).toBe("pendiente"); // no se tocó
  });
});
