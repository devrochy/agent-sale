import { resolveNotificationRecipients } from "../admin/auth/adminsDirectory.js";
import { marcarPagoRechazado } from "../domains/commerce/estadoPedido.js";
import { verifyWompiChecksum } from "../payments/wompiSignature.js";
import {
  getReportRecipient,
  getWompiConfig,
  resolveWompiPaymentLink,
  withTransaction,
} from "../shared/db/index.js";
import { logger } from "../shared/observability/logger.js";
import { sendWhatsAppMessage } from "./sendMessage.js";

interface WompiEventPayload {
  event?: string;
  data?: {
    transaction?: {
      id?: string;
      status?: string;
      payment_link_id?: string | null;
    };
  };
  signature?: {
    properties?: string[];
    checksum?: string;
  };
  timestamp?: number;
}

export interface WompiWebhookResult {
  status: 200 | 400;
  reason:
    | "ok"
    | "invalid_payload"
    | "unknown_payment_link"
    | "invalid_checksum"
    | "not_approved"
    | "rejected";
}

function buildApprovalNotification(orderId: string, total: number): string {
  return `💰 Pago confirmado — ForMotos\nPedido: ${orderId}\nMonto: $${total.toLocaleString("es-CO")}\nYa podés aprobar el envío.`;
}

function buildRejectionNotification(orderId: string, wompiStatus: string): string {
  return (
    `⚠️ Pago rechazado — ForMotos\nPedido: ${orderId}\nWompi lo reportó como ${wompiStatus}.\n` +
    `El pedido quedó marcado como rechazado. Si el cliente quiere reintentar, hay que generarle un pedido nuevo.`
  );
}

/**
 * Resultados finales de Wompi: la transacción no va a aprobarse después.
 * PENDING queda deliberadamente afuera — es transitorio (PSE sobre todo) y
 * Wompi manda otro evento cuando resuelve.
 */
const RECHAZOS_WOMPI = new Set(["DECLINED", "VOIDED", "ERROR"]);

/**
 * Aviso best-effort a los admins con `recibeNotificacionPagos` (Fase 13,
 * ver ADR-025); si no hay ninguno cae al `report_recipient_phone` legado,
 * mismo criterio que dailyReport.ts. Un destinatario que falla no frena al
 * resto: el pedido ya quedó marcado, el aviso es adicional.
 */
async function notificarAdmins(
  text: string,
  // Lo único que necesita de acá adentro es poder avisar que un envío
  // falló; pedir el tipo completo de pino arrastra sus genéricos y no
  // compila contra el logger hijo.
  wompiLogger: { warn: (obj: object, msg: string) => void },
): Promise<void> {
  const fallbackPhone = await getReportRecipient();
  const recipients = await resolveNotificationRecipients("recibeNotificacionPagos", fallbackPhone);
  for (const recipient of recipients) {
    try {
      await sendWhatsAppMessage(recipient, text);
    } catch (error) {
      wompiLogger.warn(
        { error, event: "wompi.notificacion_fallida", recipient },
        "No se pudo notificar a este destinatario",
      );
    }
  }
}

/**
 * Orquesta el webhook `transaction.updated` de Wompi (Fase 12.4, ver
 * docs/fase-12-capacidades-proactivas-agente/adrs/ADR-024-cobros-wompi-confirmacion-automatica.md)
 * como función pura, testeable sin levantar un servidor HTTP real — mismo
 * criterio que handleInboundWebhook (src/gateway/webhookHandler.ts).
 *
 * `payment_link_id` resuelve a qué pedido pertenece la transacción (ver
 * wompiPaymentLinkDirectory.ts) *antes* de poder verificar el checksum
 * contra el secreto de eventos configurado (BYOK). Un `payment_link_id`
 * desconocido o un checksum inválido responden sin tocar ningún pedido. La
 * actualización es idempotente (`WHERE payment_status = 'pendiente'`) —
 * reintentos o entregas duplicadas de Wompi (hasta 3 en 24h si no
 * respondemos 200) no vuelven a notificar al operador.
 */
export async function handleWompiWebhook(body: unknown): Promise<WompiWebhookResult> {
  const payload = body as WompiEventPayload;
  const transaction = payload.data?.transaction;
  const paymentLinkId = transaction?.payment_link_id;
  const properties = payload.signature?.properties;
  const checksum = payload.signature?.checksum;
  const timestamp = payload.timestamp;

  if (
    !transaction?.id ||
    !transaction.status ||
    !paymentLinkId ||
    !properties ||
    !checksum ||
    typeof timestamp !== "number"
  ) {
    // Payload que nunca va a cambiar en un reintento — 200 para no generar
    // una tormenta de reintentos de Wompi (mismo criterio que
    // "invalid_payload" en webhookHandler.ts).
    return { status: 200, reason: "invalid_payload" };
  }

  const link = await resolveWompiPaymentLink(paymentLinkId);
  if (!link) {
    logger.warn(
      { event: "wompi.link_desconocido", payment_link_id: paymentLinkId },
      "Webhook de Wompi para un payment_link_id que no corresponde a ningún pedido propio",
    );
    return { status: 200, reason: "unknown_payment_link" };
  }

  const wompiLogger = logger.child({ order_id: link.orderId });

  const wompiConfig = await getWompiConfig();
  const checksumValid =
    !!wompiConfig.eventsSecret &&
    verifyWompiChecksum(payload.data, properties, timestamp, checksum, wompiConfig.eventsSecret);
  if (!checksumValid) {
    wompiLogger.warn({ event: "wompi.checksum_invalido" }, "Checksum de webhook de Wompi inválido");
    return { status: 400, reason: "invalid_checksum" };
  }

  // DECLINED/VOIDED/ERROR son resultados finales: la transacción no va a
  // aprobarse después. Hasta ahora se descartaban con un log, así que el
  // pedido se quedaba "pendiente de pago" hasta que el job de los 5 días lo
  // vencía — y nadie se enteraba de que el pago había rebotado hoy.
  //
  // PENDING sí se ignora: es un estado transitorio (PSE, sobre todo) y
  // Wompi manda otro evento cuando resuelve.
  if (RECHAZOS_WOMPI.has(transaction.status)) {
    const registrado = await marcarPagoRechazado(
      link.orderId,
      `Wompi reportó la transacción como ${transaction.status}.`,
    );
    wompiLogger.info(
      { event: "wompi.pago_rechazado", status: transaction.status, registrado },
      registrado
        ? "Pago de Wompi rechazado, pedido marcado como rechazado"
        : "Pago de Wompi rechazado sobre un pedido que ya no estaba pendiente — sin cambios",
    );
    if (registrado) {
      await notificarAdmins(
        buildRejectionNotification(link.orderId, transaction.status),
        wompiLogger,
      );
    }
    return { status: 200, reason: "rejected" };
  }

  if (transaction.status !== "APPROVED") {
    wompiLogger.info(
      { event: "wompi.transaccion_no_aprobada", status: transaction.status },
      "Transacción de Wompi no aprobada — no se marca el pedido como pagado",
    );
    return { status: 200, reason: "not_approved" };
  }

  const updatedTotal = await withTransaction(async (client) => {
    const result = await client.query<{ total: string }>(
      `UPDATE orders SET payment_status = 'pagado', paid_at = now(), wompi_transaction_id = $1
       WHERE id = $2 AND payment_status = 'pendiente'
       RETURNING total`,
      [transaction.id, link.orderId],
    );
    return result.rows[0] ? Number(result.rows[0].total) : null;
  });

  if (updatedTotal !== null) {
    wompiLogger.info({ event: "wompi.pago_confirmado" }, "Pago de Wompi confirmado, pedido marcado como pagado");
    await notificarAdmins(buildApprovalNotification(link.orderId, updatedTotal), wompiLogger);
  }

  return { status: 200, reason: "ok" };
}
