import { resolveNotificationRecipients } from "../../admin/auth/adminsDirectory.js";
import { sendWhatsAppMessage, sendToConversation } from "../../gateway/sendMessage.js";
import { analizarComprobante, type ComprobanteAnalizado } from "../../payments/ocrComprobante.js";
import { getCachedMediaResult, setCachedMediaResult } from "../../shared/mediaResultCache.js";
import { withTransaction } from "../../shared/db/withTransaction.js";
import { getReportRecipient, getTransferAccounts } from "../../shared/db/settingsDirectory.js";
import {
  actualizarResultadoReceipt,
  getPaymentReceipt,
  registrarPaymentReceipt,
} from "../../shared/db/paymentReceiptsDirectory.js";
import { logger } from "../../shared/observability/logger.js";
import { marcarPagoAprobado, marcarPagoRechazado } from "./estadoPedido.js";
import { notificarClientePagoAprobado, notificarClientePagoRechazado } from "./notificarPagoCliente.js";
import { formatearDatosTransferencia } from "./datosTransferencia.js";

/**
 * Comprobante de transferencia con OCR (ver migración 0060 y el docblock
 * de `ocrComprobante.ts`). Punto de entrada único desde el pipeline de
 * ingesta de medios (`orchestrator/mediaIngestion.ts`) cuando el cliente
 * manda una foto y tiene un pedido por transferencia esperando pago.
 *
 * Todas las decisiones acá son determinísticas — el LLM conversacional
 * nunca interviene, mismo criterio que `datosTransferencia.ts`: un control
 * financiero no puede depender de que un modelo "decida bien".
 */

const LIMITE_INTENTOS = 2;
/** Margen de tolerancia en pesos para el redondeo/lectura del OCR — no exige coincidencia centavo a centavo. */
const TOLERANCIA_MONTO = 100;

export interface PedidoPendienteTransferencia {
  orderId: string;
  conversationId: string;
  publicOrderNumber: string;
}

/** Usado por el ruteo de medios entrantes para decidir si una imagen es (probablemente) un comprobante. */
export async function buscarPedidoPendienteTransferencia(
  customerId: string,
): Promise<PedidoPendienteTransferencia | null> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      conversation_id: string;
      public_order_number: string;
    }>(
      `SELECT id, conversation_id, public_order_number
         FROM orders
        WHERE customer_id = $1 AND payment_method = 'transferencia'
          AND payment_status = 'pendiente' AND status = 'abierto'
        ORDER BY created_at DESC
        LIMIT 1`,
      [customerId],
    );
    const row = result.rows[0];
    return row ? { orderId: row.id, conversationId: row.conversation_id, publicOrderNumber: row.public_order_number } : null;
  });
}

interface OrderParaComprobante {
  total: number;
  conversationId: string;
  publicOrderNumber: string;
  comprobanteIntentos: number;
}

async function fetchOrderParaComprobante(orderId: string): Promise<OrderParaComprobante | null> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      total: string;
      conversation_id: string;
      public_order_number: string;
      comprobante_intentos: number;
    }>(
      `SELECT total, conversation_id, public_order_number, comprobante_intentos FROM orders WHERE id = $1`,
      [orderId],
    );
    const row = result.rows[0];
    return row
      ? {
          total: Number(row.total),
          conversationId: row.conversation_id,
          publicOrderNumber: row.public_order_number,
          comprobanteIntentos: row.comprobante_intentos,
        }
      : null;
  });
}

async function incrementarIntentosComprobante(orderId: string): Promise<number> {
  return withTransaction(async (client) => {
    const result = await client.query<{ comprobante_intentos: number }>(
      `UPDATE orders SET comprobante_intentos = comprobante_intentos + 1 WHERE id = $1 RETURNING comprobante_intentos`,
      [orderId],
    );
    return result.rows[0]?.comprobante_intentos ?? 0;
  });
}

/** Solo dígitos — para no fallar la comparación por un guion o un espacio que el OCR (o la cuenta guardada) pusieron distinto. */
function normalizarCuenta(valor: string): string {
  return valor.replace(/\D/g, "");
}

/**
 * Aviso best-effort a los admins con `recibeNotificacionPagos` — mismo
 * criterio y mismo permiso que `notificarAdmins` en `wompiWebhookHandler.ts`
 * (no se reusa esa función porque vive en `gateway/`, capa por encima de
 * `domains/`, y este archivo no debe depender hacia arriba).
 */
async function notificarAdminsRevision(text: string): Promise<void> {
  const fallbackPhone = await getReportRecipient();
  const recipients = await resolveNotificationRecipients("recibeNotificacionPagos", fallbackPhone);
  for (const recipient of recipients) {
    try {
      await sendWhatsAppMessage(recipient, text);
    } catch (error) {
      logger.warn(
        { error, event: "comprobante.notificacion_fallida", recipient },
        "No se pudo notificar a este destinatario",
      );
    }
  }
}

export type ProcesarComprobanteResultado =
  | "aprobado"
  | "rechazado_datos"
  | "pedir_otra_foto"
  | "escalado"
  | "error_tecnico";

export interface ProcesarComprobanteInput {
  orderId: string;
  inboundMediaId: string;
  /** Id del mensaje en el proveedor — clave de la cache de idempotencia (ver `mediaResultCache.ts`), para no volver a pagar el OCR si un reintento de la cola repite este mismo mensaje. */
  messageSid: string;
  buffer: Buffer;
  mimeType: string;
}

/**
 * OCR con cache de idempotencia por `messageSid`: si un reintento de la
 * cola (`consumer.ts`) vuelve a llamar esto para el mismo mensaje —porque
 * algo DESPUÉS del OCR falló, no el OCR en sí—, reusa el resultado ya
 * pagado en vez de volver a llamar a Claude.
 */
async function analizarComprobanteConCache(input: ProcesarComprobanteInput): Promise<ComprobanteAnalizado> {
  const cacheado = await getCachedMediaResult<ComprobanteAnalizado>(input.messageSid);
  if (cacheado) {
    logger.info({ event: "comprobante.ocr_cacheado", order_id: input.orderId }, "Reusando lectura de OCR ya hecha (reintento)");
    return cacheado.value;
  }
  const analisis = await analizarComprobante(input.buffer, input.mimeType);
  await setCachedMediaResult(input.messageSid, analisis);
  return analisis;
}

export async function procesarComprobante(input: ProcesarComprobanteInput): Promise<ProcesarComprobanteResultado> {
  const orden = await fetchOrderParaComprobante(input.orderId);
  if (!orden) {
    throw new Error(`Pedido no encontrado al procesar comprobante: ${input.orderId}`);
  }

  let analisis: ComprobanteAnalizado;
  try {
    analisis = await analizarComprobanteConCache(input);
  } catch (error) {
    // Un fallo real de la llamada (red, rate limit, key inválida) — no es
    // "no se pudo leer con certeza" (eso ya lo maneja el resto de la
    // función devolviendo un resultado normal). Se trata como escalado
    // directo: sin esto, el cliente que mandó su comprobante no recibía
    // ningún aviso y el fallo solo quedaba en el log del dead-letter.
    logger.warn(
      { error, event: "comprobante.error_ocr", order_id: input.orderId },
      "Falló la llamada de OCR — se escala directo en vez de reintentar en silencio",
    );
    await registrarPaymentReceipt({
      orderId: input.orderId,
      inboundMediaId: input.inboundMediaId,
      ocrMonto: null,
      ocrCuenta: null,
      resultado: "pendiente_revision",
    });
    await escalar(orden, input.orderId);
    return "error_tecnico";
  }

  // Ninguno de los dos datos se pudo leer con certeza, o coincidieron pero
  // no pasaron la validación de abajo — en ambos casos es "no se pudo
  // confirmar el pago con este comprobante", y las dos comparten el mismo
  // límite de reintentos antes de escalar a un admin.
  const legible = analisis.monto !== null && analisis.cuentaDestino !== null;
  let montoCoincide = false;
  let cuentaCoincide = false;
  if (legible) {
    montoCoincide = Math.abs(analisis.monto! - orden.total) <= TOLERANCIA_MONTO;
    const cuentasValidas = (await getTransferAccounts())
      .filter((cuenta) => cuenta.active)
      .map((cuenta) => normalizarCuenta(cuenta.accountNumber));
    cuentaCoincide = cuentasValidas.includes(normalizarCuenta(analisis.cuentaDestino!));
  }

  if (legible && montoCoincide && cuentaCoincide) {
    // El segundo parámetro es `wompi_transaction_id` en el schema (nace
    // pensado solo para Wompi, ver estadoPedido.ts) — para transferencia se
    // usa como referencia genérica de qué comprobante aprobó el pago.
    // El guard real está en marcarPagoAprobado (`payment_status = 'pendiente'`
    // en el UPDATE) — devuelve `null` si el pedido ya no estaba pendiente
    // (dos fotos del mismo comprobante, o un admin que ya lo aprobó a mano
    // mientras esta corría). Sin chequear esto se registraba OTRO receipt y
    // se le mandaba al cliente un segundo aviso de "pago aprobado" y un
    // segundo token de reseña por el mismo pago.
    const total = await marcarPagoAprobado(input.orderId, `comprobante:${input.inboundMediaId}`);
    if (total === null) {
      logger.info(
        { event: "comprobante.ya_estaba_pagado", order_id: input.orderId },
        "El pedido ya no estaba pendiente cuando el OCR terminó de leer — no se duplica la aprobación",
      );
      return "aprobado";
    }
    await registrarPaymentReceipt({
      orderId: input.orderId,
      inboundMediaId: input.inboundMediaId,
      ocrMonto: analisis.monto,
      ocrCuenta: analisis.cuentaDestino,
      resultado: "aprobado_auto",
    });
    await notificarClientePagoAprobado(input.orderId);
    return "aprobado";
  }

  if (legible) {
    // Se leyó bien, pero el monto o la cuenta no son los que corresponden —
    // NO se marca `rechazado` (ese es un estado terminal): el pedido sigue
    // `pendiente` para que el cliente pueda mandar el comprobante correcto
    // sin quedar trabado. Se le explica qué no coincidió y se le reenvían
    // los datos correctos.
    await registrarPaymentReceipt({
      orderId: input.orderId,
      inboundMediaId: input.inboundMediaId,
      ocrMonto: analisis.monto,
      ocrCuenta: analisis.cuentaDestino,
      resultado: "rechazado_auto",
    });
    const intentos = await incrementarIntentosComprobante(input.orderId);
    if (intentos > LIMITE_INTENTOS) {
      // El receipt de arriba quedó en 'rechazado_auto' — sin este segundo
      // registro en 'pendiente_revision', listReceiptsPendientesDeRevision
      // (que mira solo el ÚLTIMO receipt de cada pedido) no encuentra este
      // pedido y nunca aparece en el panel, aunque sí se escaló.
      await registrarPaymentReceipt({
        orderId: input.orderId,
        inboundMediaId: input.inboundMediaId,
        ocrMonto: analisis.monto,
        ocrCuenta: analisis.cuentaDestino,
        resultado: "pendiente_revision",
      });
      await escalar(orden, input.orderId);
      return "escalado";
    }
    const cuentas = (await getTransferAccounts()).filter((cuenta) => cuenta.active);
    const detalleProblema = !montoCoincide
      ? `el monto que leímos (${formatearPesos(analisis.monto!)}) no coincide con el total del pedido (${formatearPesos(orden.total)})`
      : "el número de cuenta no coincide con ninguna de nuestras cuentas";
    await sendToConversation(
      orden.conversationId,
      `Revisamos tu comprobante y ${detalleProblema}. ¿Podés confirmar el monto correcto o mandarnos el comprobante que corresponde?\n\n` +
        (cuentas.length > 0 ? formatearDatosTransferencia(cuentas, orden.publicOrderNumber, orden.total) : ""),
    );
    return "rechazado_datos";
  }

  // No se pudo leer nada con certeza — se le pide otra foto en vez de
  // rechazar (una imagen borrosa no es evidencia de que el pago esté mal).
  const intentos = await incrementarIntentosComprobante(input.orderId);
  if (intentos > LIMITE_INTENTOS) {
    await registrarPaymentReceipt({
      orderId: input.orderId,
      inboundMediaId: input.inboundMediaId,
      ocrMonto: null,
      ocrCuenta: null,
      resultado: "pendiente_revision",
    });
    await escalar(orden, input.orderId);
    return "escalado";
  }
  await sendToConversation(
    orden.conversationId,
    "No pudimos leer bien la imagen del comprobante 📄 ¿Podés mandarla de nuevo, bien enfocada y completa (que se vea el monto y la cuenta destino)?",
  );
  return "pedir_otra_foto";
}

async function escalar(orden: OrderParaComprobante, orderId: string): Promise<void> {
  await sendToConversation(
    orden.conversationId,
    "Ya te avisamos a un asesor para que revise tu comprobante a mano — te confirmamos en cuanto lo revise. Gracias por la paciencia 🙏",
  );
  await notificarAdminsRevision(
    `📄 Comprobante de transferencia pendiente de revisión — ForMotos\nPedido: ${orden.publicOrderNumber}\nMonto esperado: ${formatearPesos(orden.total)}\nRevisalo en el panel.`,
  );
  logger.info(
    { event: "comprobante.escalado", order_id: orderId },
    "Comprobante escalado a revisión manual tras agotar los reintentos",
  );
}

function formatearPesos(monto: number): string {
  return `$${monto.toLocaleString("es-CO")}`;
}

/**
 * Resolución manual desde el panel (`/admin/comprobantes`) de un
 * comprobante escalado tras agotar los reintentos automáticos. Reusa
 * `marcarPagoAprobado`/`notificarClientePagoAprobado` — el mismo camino que
 * usan tanto el OCR automático de acá arriba como el webhook de Wompi
 * (`wompiWebhookHandler.ts`): una sola escritura real de "pago aprobado" en
 * todo el sistema, no una por origen.
 */
export async function aprobarComprobanteManual(
  orderId: string,
  receiptId: string,
  adminUsername: string,
): Promise<boolean> {
  // `orders` y `payment_receipts` se actualizan cada uno por su propio id,
  // sin ningún join entre los dos — sin este chequeo, un formulario
  // desincronizado (doble submit, una pestaña vieja) podría aprobar el
  // pago de un pedido y marcar como resuelto el receipt de OTRO.
  const receipt = await getPaymentReceipt(receiptId);
  if (!receipt || receipt.orderId !== orderId) {
    logger.warn(
      { event: "comprobante.receipt_no_coincide", order_id: orderId, receipt_id: receiptId },
      "El receipt no existe o no pertenece a este pedido — se ignora la acción",
    );
    return false;
  }
  const total = await marcarPagoAprobado(orderId, `comprobante-admin:${adminUsername}`);
  if (total === null) {
    return false;
  }
  await actualizarResultadoReceipt(receiptId, "aprobado_admin");
  await notificarClientePagoAprobado(orderId);
  logger.info(
    { event: "comprobante.aprobado_admin", order_id: orderId, admin: adminUsername },
    "Comprobante aprobado a mano desde el panel",
  );
  return true;
}

/**
 * A diferencia del rechazo automático por datos que no coinciden (que deja
 * el pedido `pendiente` para no trabar al cliente), un rechazo manual SÍ
 * marca `payment_status = 'rechazado'`: un admin ya miró el comprobante y
 * decidió que no sirve — es la misma decisión terminal que un rechazo de
 * Wompi, y usa la misma plantilla de aviso al cliente
 * (`notificarClientePagoRechazado`, "hay que generarle un pedido nuevo" si
 * quiere reintentar).
 */
export async function rechazarComprobanteManual(
  orderId: string,
  receiptId: string,
  adminUsername: string,
): Promise<boolean> {
  const receipt = await getPaymentReceipt(receiptId);
  if (!receipt || receipt.orderId !== orderId) {
    logger.warn(
      { event: "comprobante.receipt_no_coincide", order_id: orderId, receipt_id: receiptId },
      "El receipt no existe o no pertenece a este pedido — se ignora la acción",
    );
    return false;
  }
  const aplicado = await marcarPagoRechazado(orderId, `Comprobante rechazado a mano por ${adminUsername}.`);
  if (!aplicado) {
    return false;
  }
  await actualizarResultadoReceipt(receiptId, "rechazado_admin");
  await notificarClientePagoRechazado(orderId);
  logger.info(
    { event: "comprobante.rechazado_admin", order_id: orderId, admin: adminUsername },
    "Comprobante rechazado a mano desde el panel",
  );
  return true;
}
