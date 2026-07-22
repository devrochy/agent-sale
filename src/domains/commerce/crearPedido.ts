import { createHash } from "node:crypto";
import { withTenant } from "../../shared/db/index.js";

export type PaymentMethod = "transferencia" | "efectivo_contraentrega" | "tarjeta";
export type DeliveryMethod = "domicilio" | "recoger_en_tienda";

export interface CrearPedidoInput {
  quote_id: string;
  payment_method: PaymentMethod;
  delivery_method: DeliveryMethod;
}

export interface CrearPedidoOutput {
  order_id: string;
  status: "confirmed" | "duplicate";
  total: number;
}

/**
 * Genera el idempotency_key de forma determinística a partir del quote_id
 * y un identificador estable del intento de confirmación — el
 * message_sid del mensaje de WhatsApp que disparó la llamada (ver
 * docs/fase-6-dominio-comercial/flujo-cotizacion-pedido.md). A propósito
 * NO se expone como parámetro de la tool al LLM (ver
 * orchestrator/toolDefinitions.ts): el mecanismo depende de datos que el
 * modelo nunca ve, y un valor inventado por el LLM no sería estable entre
 * reintentos — igual que tenant_id/conversation_id, lo inyecta el
 * orquestador, no el modelo.
 */
function buildIdempotencyKey(quoteId: string, messageSid: string): string {
  return createHash("sha256").update(`${quoteId}:${messageSid}`).digest("hex");
}

/**
 * Tool crear_pedido (ver docs/fase-1-arquitectura/contratos-tools.md y
 * docs/fase-6-dominio-comercial/flujo-cotizacion-pedido.md). Convierte una
 * cotización en pedido. Dos capas de protección contra duplicados: (1)
 * una cotización ya convertida en pedido (cualquier intento posterior
 * sobre el mismo quote_id, venga o no del mismo mensaje) siempre devuelve
 * el pedido existente con status "duplicate" — coherente con que el
 * modelo de datos trata `quotes -> orders` como 0..1; (2) el
 * idempotency_key (UNIQUE en Postgres) protege además contra una carrera
 * entre dos intentos concurrentes para la misma cotización.
 */
export async function crearPedido(
  tenantId: string,
  messageSid: string,
  input: CrearPedidoInput,
): Promise<CrearPedidoOutput> {
  const idempotencyKey = buildIdempotencyKey(input.quote_id, messageSid);

  return withTenant(tenantId, async (client) => {
    const existing = await client.query<{ id: string; total: string }>(
      `SELECT id, total FROM orders WHERE tenant_id = $1 AND quote_id = $2`,
      [tenantId, input.quote_id],
    );
    if (existing.rows[0]) {
      return {
        order_id: existing.rows[0].id,
        status: "duplicate",
        total: Number(existing.rows[0].total),
      };
    }

    const quoteResult = await client.query<{
      id: string;
      conversation_id: string;
      customer_id: string;
      total: string;
    }>(`SELECT id, conversation_id, customer_id, total FROM quotes WHERE id = $1`, [
      input.quote_id,
    ]);
    const quote = quoteResult.rows[0];
    if (!quote) {
      throw new Error(`Cotización no encontrada: ${input.quote_id}`);
    }

    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, quote_id, conversation_id, customer_id, status, payment_method, delivery_method, idempotency_key, total)
       VALUES ($1, $2, $3, $4, 'confirmed', $5, $6, $7, $8)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        tenantId,
        input.quote_id,
        quote.conversation_id,
        quote.customer_id,
        input.payment_method,
        input.delivery_method,
        idempotencyKey,
        quote.total,
      ],
    );

    if (!order.rows[0]) {
      // Carrera entre el SELECT y el INSERT (muy improbable en este
      // sistema, el loop del orquestador es secuencial por conversación).
      const raced = await client.query<{ id: string; total: string }>(
        `SELECT id, total FROM orders WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      return {
        order_id: raced.rows[0]!.id,
        status: "duplicate",
        total: Number(raced.rows[0]!.total),
      };
    }
    const orderId = order.rows[0].id;

    await client.query(
      `INSERT INTO order_items (tenant_id, order_id, product_id, quantity, unit_price)
       SELECT $1, $2, product_id, quantity, unit_price FROM quote_items WHERE quote_id = $3`,
      [tenantId, orderId, input.quote_id],
    );

    return { order_id: orderId, status: "confirmed", total: Number(quote.total) };
  });
}
