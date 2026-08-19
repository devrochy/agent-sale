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

/**
 * Guarda la URL del enlace en el propio pedido, no en
 * `wompi_payment_links`: esa tabla existe para resolver
 * payment_link_id -> pedido cuando entra un webhook, y el panel necesita la
 * URL leyendo el pedido, sin un join más por fila de la tabla de Pedidos.
 */
export async function guardarPaymentLinkUrl(orderId: string, url: string): Promise<void> {
  await pool.query(`UPDATE orders SET wompi_payment_link_url = $1 WHERE id = $2`, [url, orderId]);
}

export async function resolveWompiPaymentLink(paymentLinkId: string): Promise<{ orderId: string } | null> {
  const result = await pool.query<{ order_id: string }>(
    `SELECT order_id FROM wompi_payment_links WHERE payment_link_id = $1`,
    [paymentLinkId],
  );
  const row = result.rows[0];
  return row ? { orderId: row.order_id } : null;
}
