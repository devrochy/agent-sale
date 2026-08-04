import { withTransaction } from "../../shared/db/index.js";

export interface ConsultarEstadoPedidoInput {
  public_order_number: string;
}

export interface ConsultarEstadoPedidoItem {
  name: string;
  quantity: number;
}

export interface ConsultarEstadoPedidoOutput {
  found: boolean;
  public_order_number?: string;
  status?: string;
  payment_status?: string;
  delivery_method?: string;
  tracking_number?: string | null;
  carrier?: string | null;
  total?: number;
  created_at?: string;
  items?: ConsultarEstadoPedidoItem[];
}

interface OrderRow {
  public_order_number: string;
  status: string;
  payment_status: string;
  delivery_method: string;
  tracking_number: string | null;
  carrier: string | null;
  total: string;
  created_at: string;
}

// FM-0001, fm0001, fm 1 -> 'FM-0001'. Un número que no matchea este patrón
// no existe y no vale la pena consultar la base.
const PUBLIC_ORDER_NUMBER_PATTERN = /^\s*FM[-\s]?(\d{1,4})\s*$/i;

/**
 * Tool consultar_estado_pedido (Fase 16, ver ADR-034 y
 * docs/fase-16-estado-pedido-pagos-logistica/contratos-tools-v4.md).
 *
 * Filtra siempre por `customerId` además de `public_order_number`: el
 * número es secuencial y por lo tanto adivinable (FM-0001, FM-0002...), así
 * que un número que existe pero es de otro cliente devuelve el mismo
 * `found: false` que uno inexistente — nunca revela que el pedido existe.
 */
export async function consultarEstadoPedido(
  customerId: string,
  input: ConsultarEstadoPedidoInput,
): Promise<ConsultarEstadoPedidoOutput> {
  const match = PUBLIC_ORDER_NUMBER_PATTERN.exec(input.public_order_number);
  if (!match) {
    return { found: false };
  }
  const normalized = `FM-${match[1]!.padStart(4, "0")}`;

  return withTransaction(async (client) => {
    const orderResult = await client.query<OrderRow>(
      `SELECT public_order_number, status, payment_status, delivery_method, tracking_number, carrier, total, created_at
       FROM orders
       WHERE public_order_number = $1 AND customer_id = $2`,
      [normalized, customerId],
    );
    const order = orderResult.rows[0];
    if (!order) {
      return { found: false };
    }

    const itemsResult = await client.query<{ name: string; quantity: number }>(
      `SELECT p.name, oi.quantity
       FROM order_items oi
       JOIN product_variants pv ON pv.id = oi.variant_id
       JOIN products p ON p.id = pv.product_id
       WHERE oi.order_id = (SELECT id FROM orders WHERE public_order_number = $1 AND customer_id = $2)`,
      [normalized, customerId],
    );

    return {
      found: true,
      public_order_number: order.public_order_number,
      status: order.status,
      payment_status: order.payment_status,
      delivery_method: order.delivery_method,
      tracking_number: order.tracking_number,
      carrier: order.carrier,
      total: Number(order.total),
      created_at: order.created_at,
      items: itemsResult.rows,
    };
  });
}
