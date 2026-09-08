import { withTransaction } from "../../shared/db/index.js";

export interface ActualizarDireccionPedidoInput {
  order_id: string;
  direccion_nueva: string;
  guardar_permanente: boolean;
}

export type ActualizarDireccionPedidoStatus = "actualizado" | "pedido_no_abierto";

export interface ActualizarDireccionPedidoOutput {
  order_id: string;
  status: ActualizarDireccionPedidoStatus;
}

/**
 * Tool actualizar_direccion_pedido — el otro lado de la plantilla
 * "confirmar_domicilio" cuando el cliente NO confirma la dirección que
 * tenía sino que la cambia. Cubre los botones "Cambiar temporalmente" y
 * "Cambiar permanentemente": en ambos casos se actualiza el snapshot del
 * pedido (`orders.delivery_address`); si además tocó "permanentemente",
 * también se actualiza el dato de perfil (`customers.address`) para que
 * los próximos pedidos ya la tengan — mismo patrón que `save_permanently`
 * en crearPedido.ts.
 *
 * La dirección nueva ya cuenta como confirmada (mismo criterio que
 * "Confirmar dirección": el cliente la está dando en el momento), así que
 * también marca `address_confirmed_at`. El guard por `status = 'abierto'`
 * evita pisar algo en un pedido que ya avanzó de estado por otro lado.
 */
export async function actualizarDireccionPedido(
  input: ActualizarDireccionPedidoInput,
): Promise<ActualizarDireccionPedidoOutput> {
  const customerId = await withTransaction(async (client) => {
    const result = await client.query<{ customer_id: string }>(
      `UPDATE orders SET delivery_address = $1, address_confirmed_at = now()
        WHERE id = $2 AND status = 'abierto'
        RETURNING customer_id`,
      [input.direccion_nueva, input.order_id],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    if (input.guardar_permanente) {
      await client.query(`UPDATE customers SET address = $1 WHERE id = $2`, [
        input.direccion_nueva,
        row.customer_id,
      ]);
    }
    return row.customer_id;
  });

  return {
    order_id: input.order_id,
    status: customerId ? "actualizado" : "pedido_no_abierto",
  };
}
