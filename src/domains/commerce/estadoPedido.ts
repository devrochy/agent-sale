import { withTransaction } from "../../shared/db/withTransaction.js";

/**
 * Estados del pedido (ver
 * docs/fase-16-estado-pedido-pagos-logistica/estados-y-transferencias.md y
 * migrations/0056).
 *
 * Son **dos ejes**, no uno: el ciclo del pedido (`orders.status`) y el del
 * pago (`orders.payment_status`). Un pedido puede estar pagado y sin
 * despachar, o despachado y sin pagar (contraentrega). Este módulo es el
 * único lugar que sabe cómo se combinan los dos en el estado que se lee.
 */

export const ORDER_STATUSES = ["abierto", "despachado", "entregado", "cancelado", "expirado"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ["pendiente", "pagado", "rechazado"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

/** Claves del estado derivado. Son las que se usan para filtrar en el panel, así que el valor viaja en la URL y no debe cambiar sin migrar los enlaces guardados. */
export type EstadoVisible =
  | "pendiente_pago"
  | "pagado"
  | "rechazado"
  | "despachado"
  | "entregado"
  | "cancelado"
  | "vencido";

export interface EstadoDerivado {
  key: EstadoVisible;
  label: string;
  /** Tono del chip — uno de los que ya existen en el panel (ver .chip--* en STYLE_BLOCK), para no estrenar paleta por una tabla. */
  tone: "go" | "amber" | "redline" | "violet" | "muted";
}

/**
 * Un solo estado legible a partir de los dos ejes. **El orden de las ramas
 * es la regla de negocio**: lo terminal gana sobre lo transitorio, porque un
 * pedido cancelado con el pago pendiente ya no está esperando ningún pago.
 *
 * Deliberadamente no existe un estado "abierto" visible: por sí solo no
 * dice nada accionable. Un pedido abierto está esperando el pago o ya lo
 * recibió, y eso es lo que hay que ver en la tabla.
 */
export function derivarEstado(status: string, paymentStatus: string): EstadoDerivado {
  if (status === "cancelado") {
    return { key: "cancelado", label: "Cancelado", tone: "muted" };
  }
  if (status === "expirado") {
    return { key: "vencido", label: "Vencido", tone: "muted" };
  }
  if (status === "entregado") {
    return { key: "entregado", label: "Entregado", tone: "go" };
  }
  // El rechazo pisa a "despachado" a propósito: un pedido que salió y cuyo
  // pago rebotó es exactamente el que hay que mirar primero.
  if (paymentStatus === "rechazado") {
    return { key: "rechazado", label: "Pago rechazado", tone: "redline" };
  }
  if (status === "despachado") {
    return { key: "despachado", label: "Despachado", tone: "violet" };
  }
  if (paymentStatus === "pendiente") {
    return { key: "pendiente_pago", label: "Pendiente de pago", tone: "amber" };
  }
  return { key: "pagado", label: "Pagado", tone: "go" };
}

/** Para el `<select>` de filtro del panel, en el orden en que se recorre un tablero: lo que espera algo primero. */
export const ESTADOS_VISIBLES: { key: EstadoVisible; label: string }[] = [
  { key: "pendiente_pago", label: "Pendiente de pago" },
  { key: "pagado", label: "Pagado" },
  { key: "despachado", label: "Despachado" },
  { key: "entregado", label: "Entregado" },
  { key: "rechazado", label: "Pago rechazado" },
  { key: "cancelado", label: "Cancelado" },
  { key: "vencido", label: "Vencido" },
];

/**
 * Mueve el pedido de estado. `reason` solo se guarda para las transiciones
 * sobre las que después alguien pregunta "¿y esto por qué?" — un rechazo o
 * una cancelación.
 *
 * Devuelve `false` si el pedido ya estaba en ese estado o no existe, para
 * que el caller no notifique dos veces. Mismo criterio de guard idempotente
 * que `closeExpiredOrders.ts`.
 */
export async function cambiarEstadoPedido(
  orderId: string,
  status: OrderStatus,
  reason?: string,
): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE orders
          SET status = $2, status_changed_at = now(), status_reason = $3
        WHERE id = $1 AND status != $2`,
      [orderId, status, reason ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

/**
 * Registra un pago rechazado. Va acá y no en el webhook porque el rechazo
 * puede llegar por dos caminos —Wompi, o un admin que revisó una
 * transferencia y no la encontró— y los dos tienen que dejar la misma
 * huella.
 *
 * El guard es `payment_status = 'pendiente'`: un pago ya confirmado no se
 * revierte por un webhook que llega tarde y desordenado.
 */
export async function marcarPagoRechazado(orderId: string, reason: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE orders
          SET payment_status = 'rechazado', status_changed_at = now(), status_reason = $2
        WHERE id = $1 AND payment_status = 'pendiente'`,
      [orderId, reason],
    );
    return (result.rowCount ?? 0) > 0;
  });
}
