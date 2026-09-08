import { withTransaction } from "./withTransaction.js";

/**
 * Comprobantes de transferencia (ver migración 0060 y
 * `domains/commerce/procesarComprobante.ts`). Un registro por CADA intento,
 * no solo el último — el panel necesita poder mostrar el historial completo
 * cuando un admin recibe un pedido escalado tras varios rechazos.
 */

export type PaymentReceiptResultado =
  | "aprobado_auto"
  | "rechazado_auto"
  | "pendiente_revision"
  | "aprobado_admin"
  | "rechazado_admin";

export interface RegistrarPaymentReceiptInput {
  orderId: string;
  inboundMediaId: string;
  ocrMonto: number | null;
  ocrCuenta: string | null;
  resultado: PaymentReceiptResultado;
}

export async function registrarPaymentReceipt(input: RegistrarPaymentReceiptInput): Promise<string> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO payment_receipts (order_id, inbound_media_id, ocr_monto, ocr_cuenta, resultado)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [input.orderId, input.inboundMediaId, input.ocrMonto, input.ocrCuenta, input.resultado],
    );
    return result.rows[0]!.id;
  });
}

export interface PaymentReceiptRecord {
  id: string;
  orderId: string;
}

/** Usado para confirmar que un `receiptId` que llega del panel de verdad pertenece al `orderId` sobre el que se está actuando, antes de aprobar/rechazar a mano — ver `/admin/comprobantes`. */
export async function getPaymentReceipt(receiptId: string): Promise<PaymentReceiptRecord | null> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string; order_id: string }>(
      `SELECT id, order_id FROM payment_receipts WHERE id = $1`,
      [receiptId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, orderId: row.order_id } : null;
  });
}

/** Usado cuando un admin resuelve a mano un comprobante escalado (ver `/admin/comprobantes`). */
export async function actualizarResultadoReceipt(
  receiptId: string,
  resultado: PaymentReceiptResultado,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`UPDATE payment_receipts SET resultado = $2 WHERE id = $1`, [receiptId, resultado]);
  });
}

export interface PaymentReceiptConPedido {
  id: string;
  orderId: string;
  inboundMediaId: string;
  ocrMonto: number | null;
  ocrCuenta: string | null;
  resultado: PaymentReceiptResultado;
  createdAt: string;
  publicOrderNumber: string;
  total: number;
  customerName: string | null;
}

/**
 * Pedidos con al menos un comprobante escalado (`pendiente_revision`) que
 * todavía no se resolvió a mano — usado por la sección nueva del panel
 * (`adminPanel.ts`). Solo el comprobante más reciente por pedido: si el
 * cliente mandó varios, al admin le interesa el último.
 */
export async function listReceiptsPendientesDeRevision(): Promise<PaymentReceiptConPedido[]> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      order_id: string;
      inbound_media_id: string;
      ocr_monto: string | null;
      ocr_cuenta: string | null;
      resultado: PaymentReceiptResultado;
      created_at: string;
      public_order_number: string;
      total: string;
      customer_name: string | null;
    }>(
      `SELECT DISTINCT ON (pr.order_id)
              pr.id, pr.order_id, pr.inbound_media_id, pr.ocr_monto, pr.ocr_cuenta, pr.resultado, pr.created_at,
              o.public_order_number, o.total, c.name AS customer_name
         FROM payment_receipts pr
         JOIN orders o ON o.id = pr.order_id
         JOIN customers c ON c.id = o.customer_id
        WHERE o.payment_status = 'pendiente' AND o.payment_method = 'transferencia'
        ORDER BY pr.order_id, pr.created_at DESC`,
    );
    return result.rows
      .filter((row) => row.resultado === "pendiente_revision")
      .map((row) => ({
        id: row.id,
        orderId: row.order_id,
        inboundMediaId: row.inbound_media_id,
        ocrMonto: row.ocr_monto !== null ? Number(row.ocr_monto) : null,
        ocrCuenta: row.ocr_cuenta,
        resultado: row.resultado,
        createdAt: row.created_at,
        publicOrderNumber: row.public_order_number,
        total: Number(row.total),
        customerName: row.customer_name,
      }));
  });
}
