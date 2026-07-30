import { createHash } from "node:crypto";
import { createWompiPaymentLink, getWompiConfig, withTenant } from "../../shared/db/index.js";
import { createPaymentLink, MIN_AMOUNT_COP } from "../../payments/wompiClient.js";

export type PaymentMethod =
  | "transferencia"
  | "efectivo_contraentrega"
  | "tarjeta"
  | "pago_en_linea";
export type DeliveryMethod = "domicilio" | "recoger_en_tienda";

export interface CrearPedidoInput {
  quote_id: string;
  payment_method: PaymentMethod;
  delivery_method: DeliveryMethod;
}

export interface CrearPedidoOutput {
  order_id: string | null;
  status:
    | "confirmed"
    | "duplicate"
    | "monto_alto"
    | "wompi_no_configurado"
    | "wompi_monto_minimo";
  total: number;
  /** Solo presente cuando payment_method es 'pago_en_linea' y status 'confirmed' (ver ADR-024). */
  payment_link_url?: string;
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
 *
 * `montoAltoThreshold` lo inyecta el orquestador (viene de
 * `escalation_config` del tenant, ver escalationRules.ts) — se evalúa acá,
 * *antes* de insertar el pedido, para que un monto alto nunca llegue a
 * quedar `status: 'confirmed'` ni descuente stock. Antes este chequeo
 * vivía en el orquestador y se aplicaba sobre el resultado de esta misma
 * tool, es decir después de que el pedido ya existía en la base — el
 * cliente recibía el mensaje de escalamiento, pero el pedido real ya
 * estaba confirmado (ver docs/fase-7-escalamiento-humano/reglas-escalamiento.md).
 *
 * `pago_en_linea` (Fase 12.4, ver ADR-024) agrega un paso de solo-lectura
 * antes del insert: la creación del link de pago es una llamada de red
 * externa a Wompi, y el patrón ya establecido en escalarHumano.ts (con
 * sendWhatsAppMessage) es no mantener una transacción de Postgres abierta
 * mientras se espera una llamada así. Por eso esta función queda en dos
 * fases — (1) chequeo de duplicado/cotización/monto alto en una
 * transacción de solo lectura, (2) la llamada a Wompi si aplica, (3) el
 * insert real en una segunda transacción — en vez de la única transacción
 * que bastaba cuando ningún método de pago hacía I/O externo. La
 * protección real contra duplicados sigue siendo el UNIQUE de
 * `idempotency_key` (ON CONFLICT + SELECT de la carrera, más abajo), no el
 * límite de la transacción — separarla en dos fases no debilita esa
 * garantía.
 */
export async function crearPedido(
  tenantId: string,
  messageSid: string,
  input: CrearPedidoInput,
  montoAltoThreshold: number,
): Promise<CrearPedidoOutput> {
  const idempotencyKey = buildIdempotencyKey(input.quote_id, messageSid);

  const checked = await withTenant(tenantId, async (client) => {
    const existing = await client.query<{ id: string; total: string }>(
      `SELECT id, total FROM orders WHERE tenant_id = $1 AND quote_id = $2`,
      [tenantId, input.quote_id],
    );
    if (existing.rows[0]) {
      return {
        kind: "duplicate" as const,
        order_id: existing.rows[0].id,
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

    const total = Number(quote.total);
    if (total > montoAltoThreshold) {
      return { kind: "monto_alto" as const, total };
    }

    return { kind: "ok" as const, quote, total };
  });

  if (checked.kind === "duplicate") {
    return { order_id: checked.order_id, status: "duplicate", total: checked.total };
  }
  if (checked.kind === "monto_alto") {
    return { order_id: null, status: "monto_alto", total: checked.total };
  }

  const { quote, total } = checked;

  let paymentLink: { paymentLinkId: string; url: string } | null = null;
  if (input.payment_method === "pago_en_linea") {
    const wompiConfig = await getWompiConfig(tenantId);
    if (!wompiConfig.privateKey) {
      return { order_id: null, status: "wompi_no_configurado", total };
    }
    // Mínimo real de Wompi para la base de una transacción (ver
    // MIN_AMOUNT_COP en wompiClient.ts) — descubierto en QA contra el
    // sandbox real, no documentado en la guía de Links de pago. Se chequea
    // ANTES de llamar a la API: evita una llamada de red que sabemos que
    // va a fallar, y evita mostrarle al cliente un error crudo de Wompi.
    if (total < MIN_AMOUNT_COP) {
      return { order_id: null, status: "wompi_monto_minimo", total };
    }
    paymentLink = await createPaymentLink(
      wompiConfig.privateKey,
      `Pedido ForMotos — cotización ${input.quote_id}`,
      total,
    );
  }

  const created = await withTenant(tenantId, async (client) => {
    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, quote_id, conversation_id, customer_id, status, payment_method, payment_status, delivery_method, idempotency_key, total, wompi_payment_link_id)
       VALUES ($1, $2, $3, $4, 'confirmed', $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        tenantId,
        input.quote_id,
        quote.conversation_id,
        quote.customer_id,
        input.payment_method,
        paymentLink ? "pendiente" : "pagado",
        input.delivery_method,
        idempotencyKey,
        quote.total,
        paymentLink?.paymentLinkId ?? null,
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
        status: "duplicate" as const,
        total: Number(raced.rows[0]!.total),
      };
    }
    const orderId = order.rows[0].id;

    await client.query(
      `INSERT INTO order_items (tenant_id, order_id, product_id, quantity, unit_price)
       SELECT $1, $2, product_id, quantity, unit_price FROM quote_items WHERE quote_id = $3`,
      [tenantId, orderId, input.quote_id],
    );

    // Descuento de stock al confirmar (ver docs/fase-5-catalogo-inventario/
    // sincronizacion-inventario.md): el diseño original deja el inventario
    // como propiedad exclusiva de la fuente externa (Sheets/ERP) — pero esa
    // sincronización nunca se implementó, así que sin este descuento el
    // stock nunca baja por ventas reales del agente y dos pedidos podrían
    // "vender" la misma última unidad. `GREATEST(...,0)` evita que quede
    // negativo si dos pedidos concurrentes agotan el mismo producto. Si en
    // el futuro se conecta una sincronización real con la fuente externa,
    // hay que decidir quién manda (este INSERT vs. el próximo sync) antes
    // de dejar ambos escribiendo `stock_quantity`.
    await client.query(
      `UPDATE inventory i
       SET stock_quantity = GREATEST(i.stock_quantity - oi.quantity, 0)
       FROM order_items oi
       WHERE oi.order_id = $1 AND oi.tenant_id = $2 AND i.tenant_id = $2 AND i.product_id = oi.product_id`,
      [orderId, tenantId],
    );

    return { order_id: orderId, status: "confirmed" as const, total };
  });

  // createWompiPaymentLink corre en una conexión propia (fuera de la
  // transacción de arriba) — igual que createHandoffToken en
  // escalarHumano.ts, se llama después de que `withTenant` ya resolvió
  // (el pedido quedó comprometido/commiteado). Insertarlo *dentro* de la
  // transacción del pedido violaría el FK a `orders`: esa fila todavía no
  // sería visible desde otra conexión hasta el COMMIT.
  if (paymentLink && created.status === "confirmed") {
    await createWompiPaymentLink(tenantId, created.order_id, paymentLink.paymentLinkId);
    return { ...created, payment_link_url: paymentLink.url };
  }

  return created;
}
