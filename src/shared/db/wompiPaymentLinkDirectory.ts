import { pool } from "./pool.js";

export interface WompiPaymentLinkLookup {
  tenantId: string;
  orderId: string;
}

/**
 * Único punto que consulta/escribe `wompi_payment_links` con el pool
 * crudo, sin pasar por `withTenant` — mismo motivo que
 * `handoffTokenDirectory.ts`: el webhook de Wompi (wompiWebhookHandler.ts)
 * llega sin `tenant_id`, y resolver `payment_link_id` es el paso anterior
 * a poder abrir una sesión con `app.tenant_id` (ver
 * migrations/0031_wompi_payment_links.cjs). A diferencia de
 * `handoff_tokens`, el id no lo generamos nosotros con `randomBytes` — lo
 * asigna Wompi al crear el link (ver wompiClient.ts), acá solo se guarda
 * la correlación.
 */
export async function createWompiPaymentLink(
  tenantId: string,
  orderId: string,
  paymentLinkId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO wompi_payment_links (payment_link_id, tenant_id, order_id) VALUES ($1, $2, $3)`,
    [paymentLinkId, tenantId, orderId],
  );
}

export async function resolveWompiPaymentLink(
  paymentLinkId: string,
): Promise<WompiPaymentLinkLookup | null> {
  const result = await pool.query<{ tenant_id: string; order_id: string }>(
    `SELECT tenant_id, order_id FROM wompi_payment_links WHERE payment_link_id = $1`,
    [paymentLinkId],
  );
  const row = result.rows[0];
  return row ? { tenantId: row.tenant_id, orderId: row.order_id } : null;
}
