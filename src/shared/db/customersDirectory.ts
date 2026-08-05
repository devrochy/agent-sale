import { withTransaction } from "./withTransaction.js";

/**
 * Perfil de entrega del cliente (Fase 15, `migrations/0046_customers_datos_entrega.cjs`)
 * y kill switch de bot por cliente (Fase 23, `migrations/0050_...`), editables
 * desde el panel admin (Fase 23 sub-fase 3, ver ADR-036 "Modal de detalle/edición
 * de lead"). Nunca toca `orders.delivery_*` — esas son la copia congelada de un
 * pedido en curso (Fase 15/ADR-033), distinta del perfil permanente del cliente.
 */
export interface CustomerProfileInput {
  fullName: string | null;
  idDocument: string | null;
  address: string | null;
  municipality: string | null;
  city: string | null;
}

export async function updateCustomerProfile(customerId: string, input: CustomerProfileInput): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE customers SET full_name = $1, id_document = $2, address = $3, municipality = $4, city = $5 WHERE id = $6`,
      [input.fullName, input.idDocument, input.address, input.municipality, input.city, customerId],
    );
  });
}

export async function setCustomerBotPaused(customerId: string, paused: boolean): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`UPDATE customers SET bot_paused = $1 WHERE id = $2`, [paused, customerId]);
  });
}
