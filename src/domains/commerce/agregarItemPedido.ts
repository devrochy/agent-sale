import { createWompiPaymentLink, getWompiConfig, withTransaction } from "../../shared/db/index.js";
import { createPaymentLink } from "../../payments/wompiClient.js";
import { buildIdempotencyKey } from "./idempotency.js";
import type { CotizacionItemOutput } from "./generarCotizacion.js";

export interface AgregarItemPedidoInput {
  order_id: string;
  items: { variant_id: string; quantity: number }[];
}

export interface AgregarItemPedidoOutput {
  order_id: string;
  status: "actualizado" | "duplicate" | "pedido_no_abierto" | "monto_alto";
  items_agregados: CotizacionItemOutput[];
  total: number;
  /** Solo presente si el pedido es pago_en_linea y ya tenía un link pendiente (se regenera con el total actualizado). */
  payment_link_url?: string;
}

interface VariantStockRow {
  id: string;
  name: string;
  price: string;
  stock: string;
}

/**
 * Tool agregar_item_pedido (Fase 15, ver ADR-033 y
 * docs/fase-15-datos-cliente-flujo-pedidos/contratos-tools-v3.md). Suma
 * productos a un pedido `abierto` sin generar un segundo order_id — a
 * diferencia de crear_pedido, no depende de una cotización previa: revalida
 * stock/precio real de cada variante acá mismo, mismo criterio que
 * generarCotizacion.ts.
 *
 * Idempotencia propia (order_item_batches, no orders.idempotency_key): un
 * pedido abierto puede recibir N lotes en momentos distintos, así que la
 * unidad de idempotencia es "este intento de agregar estos items", no el
 * pedido completo. El chequeo de duplicado va primero (antes incluso de
 * mirar el pedido) porque un reintento debe ser un no-op total, sin
 * volver a revalidar stock que ya pudo cambiar entre el intento original y
 * el reintento.
 *
 * `montoAltoThreshold` se evalúa sobre orders.total + el subtotal nuevo,
 * *antes* de insertar nada — mismo principio que crear_pedido: la tool se
 * niega, nunca queda un estado a medio confirmar para que el orquestador
 * decida escalar después.
 */
export async function agregarItemPedido(
  messageSid: string,
  input: AgregarItemPedidoInput,
  montoAltoThreshold: number,
): Promise<AgregarItemPedidoOutput> {
  if (input.items.length === 0) {
    throw new Error("agregar_item_pedido necesita al menos un producto.");
  }

  const idempotencyKey = buildIdempotencyKey(input.order_id, messageSid);

  const checked = await withTransaction(async (client) => {
    const existingBatch = await client.query<{ id: string }>(
      `SELECT id FROM order_item_batches WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (existingBatch.rows[0]) {
      const order = await client.query<{ total: string }>(`SELECT total FROM orders WHERE id = $1`, [
        input.order_id,
      ]);
      return { kind: "duplicate" as const, total: Number(order.rows[0]?.total ?? 0) };
    }

    const orderResult = await client.query<{
      status: string;
      total: string;
      payment_method: string;
      wompi_payment_link_id: string | null;
    }>(`SELECT status, total, payment_method, wompi_payment_link_id FROM orders WHERE id = $1`, [
      input.order_id,
    ]);
    const order = orderResult.rows[0];
    if (!order || order.status !== "abierto") {
      return { kind: "pedido_no_abierto" as const, total: Number(order?.total ?? 0) };
    }

    const items: CotizacionItemOutput[] = [];
    for (const item of input.items) {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new Error(`Cantidad inválida para la variante ${item.variant_id}: ${item.quantity}`);
      }

      const result = await client.query<VariantStockRow>(
        `SELECT pv.id, p.name, pv.price, COALESCE(i.stock_quantity, 0) AS stock
         FROM product_variants pv
         JOIN products p ON p.id = pv.product_id
         LEFT JOIN inventory i ON i.variant_id = pv.id
         WHERE pv.id = $1 AND pv.active = true`,
        [item.variant_id],
      );
      const variant = result.rows[0];
      if (!variant) {
        throw new Error(`Variante no encontrada: ${item.variant_id}`);
      }

      const stock = Number(variant.stock);
      if (stock < item.quantity) {
        throw new Error(
          `Stock insuficiente para ${variant.name}: pediste ${item.quantity}, hay ${stock} disponibles.`,
        );
      }

      const unitPrice = Number(variant.price);
      items.push({
        variant_id: variant.id,
        name: variant.name,
        quantity: item.quantity,
        unit_price: unitPrice,
        line_total: unitPrice * item.quantity,
      });
    }

    const subtotalNuevo = items.reduce((sum, item) => sum + item.line_total, 0);
    const nuevoTotal = Number(order.total) + subtotalNuevo;
    if (nuevoTotal > montoAltoThreshold) {
      return { kind: "monto_alto" as const, total: nuevoTotal };
    }

    return {
      kind: "ok" as const,
      items,
      nuevoTotal,
      paymentMethod: order.payment_method,
      existingPaymentLinkId: order.wompi_payment_link_id,
    };
  });

  if (checked.kind === "duplicate") {
    return { order_id: input.order_id, status: "duplicate", items_agregados: [], total: checked.total };
  }
  if (checked.kind === "pedido_no_abierto") {
    return {
      order_id: input.order_id,
      status: "pedido_no_abierto",
      items_agregados: [],
      total: checked.total,
    };
  }
  if (checked.kind === "monto_alto") {
    return { order_id: input.order_id, status: "monto_alto", items_agregados: [], total: checked.total };
  }

  const { items, nuevoTotal, paymentMethod, existingPaymentLinkId } = checked;

  // Solo se regenera el link si ya había uno pendiente — un pedido
  // pago_en_linea sin link activo (ya pagado, o wompi_no_configurado en su
  // momento) no gana uno nuevo por agregar productos.
  let paymentLink: { paymentLinkId: string; url: string } | null = null;
  if (paymentMethod === "pago_en_linea" && existingPaymentLinkId) {
    const wompiConfig = await getWompiConfig();
    if (wompiConfig.privateKey) {
      paymentLink = await createPaymentLink(
        wompiConfig.privateKey,
        `Pedido ForMotos — actualización ${input.order_id}`,
        nuevoTotal,
      );
    }
  }

  const created = await withTransaction(async (client) => {
    const batch = await client.query<{ id: string }>(
      `INSERT INTO order_item_batches (order_id, idempotency_key) VALUES ($1, $2)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [input.order_id, idempotencyKey],
    );

    if (!batch.rows[0]) {
      // Carrera entre el SELECT y el INSERT (muy improbable, mismo
      // criterio que crearPedido.ts).
      const order = await client.query<{ total: string }>(`SELECT total FROM orders WHERE id = $1`, [
        input.order_id,
      ]);
      return { status: "duplicate" as const, total: Number(order.rows[0]!.total) };
    }

    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, variant_id, quantity, unit_price) VALUES ($1, $2, $3, $4)`,
        [input.order_id, item.variant_id, item.quantity, item.unit_price],
      );
      // Descuento por item (no un UPDATE ... FROM order_items como en
      // crearPedido.ts): acá order_items ya puede tener filas de lotes
      // anteriores para el mismo order_id, así que hace falta acotar el
      // descuento a los items de ESTE lote — los tiene en memoria, no hace
      // falta ir a buscarlos por join.
      await client.query(
        `UPDATE inventory SET stock_quantity = GREATEST(stock_quantity - $2, 0) WHERE variant_id = $1`,
        [item.variant_id, item.quantity],
      );
    }

    await client.query(
      `UPDATE orders SET total = $2, wompi_payment_link_id = COALESCE($3, wompi_payment_link_id) WHERE id = $1`,
      [input.order_id, nuevoTotal, paymentLink?.paymentLinkId ?? null],
    );

    return { status: "actualizado" as const, total: nuevoTotal };
  });

  if (paymentLink && created.status === "actualizado") {
    await createWompiPaymentLink(input.order_id, paymentLink.paymentLinkId);
    return {
      order_id: input.order_id,
      status: "actualizado",
      items_agregados: items,
      total: created.total,
      payment_link_url: paymentLink.url,
    };
  }

  return {
    order_id: input.order_id,
    status: created.status,
    items_agregados: created.status === "actualizado" ? items : [],
    total: created.total,
  };
}
