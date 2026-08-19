import { sendToConversation } from "../../gateway/sendMessage.js";
import { getTransferAccounts, type TransferAccount } from "../../shared/db/settingsDirectory.js";
import { logger } from "../../shared/observability/logger.js";

/**
 * Datos de transferencia para el cliente (ver
 * docs/fase-16-estado-pedido-pagos-logistica/estados-y-transferencias.md).
 *
 * **Este mensaje no pasa por el LLM, y esa es la decisión central del
 * módulo.** El resto de lo que el cliente recibe lo redacta el modelo a
 * partir del output de las tools; un número de cuenta, no. Un dígito
 * alucinado o "corregido" manda la plata de alguien a una cuenta ajena, y a
 * diferencia de un enlace roto —que falla ruidosamente— una cuenta
 * equivocada parece funcionar hasta que el dinero no llega.
 *
 * Por eso se arma acá, con los datos tal como están guardados, y se manda
 * como mensaje aparte. El LLM solo se entera de que ya se mandó.
 */

function formatearCuenta(account: TransferAccount): string {
  const encabezado = account.accountType
    ? `${account.entity} — ${account.accountType}`
    : account.entity;
  const lineas = [`*${encabezado}*`, `N°: ${account.accountNumber}`, `Titular: ${account.holderName}`];
  if (account.holderDocument) {
    lineas.push(`Documento: ${account.holderDocument}`);
  }
  return lineas.join("\n");
}

export function formatearDatosTransferencia(
  accounts: TransferAccount[],
  publicOrderNumber: string,
  total: number,
): string {
  const bloques = accounts.map(formatearCuenta).join("\n\n");
  return (
    `🏦 Datos para transferir — pedido ${publicOrderNumber}\n` +
    `Monto: $${total.toLocaleString("es-CO")}\n\n` +
    `${bloques}\n\n` +
    `Cuando hagas la transferencia, mandanos el comprobante por acá y confirmamos tu pedido. 😊`
  );
}

/**
 * Manda los datos si hay al menos una cuenta activa. Devuelve si se mandó
 * algo, para que el caller pueda decirle al LLM que ya está hecho y no lo
 * repita con datos inventados.
 *
 * Best-effort, mismo criterio que las notificaciones de `escalarHumano.ts`:
 * el pedido ya quedó creado y no se revierte porque falle un envío. Pero a
 * diferencia de aquellas, acá el fallo sí deja al cliente sin poder pagar,
 * así que se loguea como `warn` con el número de pedido para poder
 * reenviarlo a mano desde el panel.
 */
export async function enviarDatosTransferencia(
  conversationId: string,
  publicOrderNumber: string,
  total: number,
): Promise<boolean> {
  const cuentas = (await getTransferAccounts()).filter((account) => account.active);
  if (cuentas.length === 0) {
    // No es un error: una tienda puede no aceptar transferencias todavía.
    // El agente sigue su curso y el admin ve el aviso en Configuración.
    logger.info(
      { event: "pedido.transferencia_sin_cuentas", public_order_number: publicOrderNumber },
      "Pedido por transferencia sin cuentas configuradas — no se mandaron datos",
    );
    return false;
  }

  try {
    await sendToConversation(
      conversationId,
      formatearDatosTransferencia(cuentas, publicOrderNumber, total),
    );
    logger.info(
      { event: "pedido.datos_transferencia_enviados", public_order_number: publicOrderNumber },
      "Datos de transferencia enviados al cliente",
    );
    return true;
  } catch (error) {
    logger.warn(
      { error, event: "pedido.datos_transferencia_fallidos", public_order_number: publicOrderNumber },
      "No se pudieron enviar los datos de transferencia — hay que reenviarlos a mano",
    );
    return false;
  }
}
