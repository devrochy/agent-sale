import { pool } from "./pool.js";

/**
 * Único punto que consulta/escribe `wompi_payment_links` con el pool
 * crudo, sin pasar por `withTransaction` — insert/select puntual (ver
 * migrations/0031_wompi_payment_links.cjs). El id no lo generamos
 * nosotros con `randomBytes` — lo asigna Wompi al crear el link (ver
 * wompiClient.ts), acá solo se guarda la correlación a un pedido.
 */
export async function createWompiPaymentLink(orderId: string, paymentLinkId: string): Promise<void> {
  await pool.query(`INSERT INTO wompi_payment_links (payment_link_id, order_id) VALUES ($1, $2)`, [
    paymentLinkId,
    orderId,
  ]);
}

export async function resolveWompiPaymentLink(paymentLinkId: string): Promise<{ orderId: string } | null> {
  const result = await pool.query<{ order_id: string }>(
    `SELECT order_id FROM wompi_payment_links WHERE payment_link_id = $1`,
    [paymentLinkId],
  );
  const row = result.rows[0];
  return row ? { orderId: row.order_id } : null;
}
