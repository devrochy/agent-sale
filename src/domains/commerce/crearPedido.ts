import {
  createWompiPaymentLink,
  getWompiConfig,
  guardarPaymentLinkUrl,
  withTransaction,
} from "../../shared/db/index.js";
import { createPaymentLink, MIN_AMOUNT_COP } from "../../payments/wompiClient.js";
import { buildIdempotencyKey } from "./idempotency.js";
import { enviarDatosTransferencia } from "./datosTransferencia.js";

export type PaymentMethod =
  | "transferencia"
  | "efectivo_contraentrega"
  | "tarjeta"
  | "pago_en_linea";
export type DeliveryMethod = "domicilio" | "recoger_en_tienda";

export type MissingCustomerField = "address" | "id_document" | "full_name" | "phone";

export interface CustomerData {
  address: string;
  id_document: string;
  full_name: string;
  municipality?: string;
  city?: string;
  /**
   * Teléfono de contacto. Solo hace falta cuando el canal no lo trae — por
   * WhatsApp la dirección del canal ya es el teléfono (Fase 19, Etapa C1).
   */
  phone?: string;
  save_permanently: boolean;
}

export interface CrearPedidoInput {
  quote_id: string;
  payment_method: PaymentMethod;
  delivery_method: DeliveryMethod;
  customer_data?: CustomerData;
}

export interface CrearPedidoOutput {
  order_id: string | null;
  status:
    | "confirmed"
    | "duplicate"
    | "monto_alto"
    | "wompi_no_configurado"
    | "wompi_monto_minimo"
    | "faltan_datos_cliente";
  total: number;
  /**
   * Número de pedido público (formato 'FM-0001', ver ADR-034) para que el
   * cliente pregunte por su estado después con consultar_estado_pedido.
   * Solo presente cuando order_id no es null.
   */
  public_order_number?: string;
  /** Solo presente cuando payment_method es 'pago_en_linea' y status 'confirmed' (ver ADR-024). */
  payment_link_url?: string;
  /**
   * `true` cuando ya se le mandaron al cliente los datos de transferencia
   * en un mensaje aparte (ver datosTransferencia.ts). El LLM NO recibe las
   * cuentas: solo este booleano, para que confirme que ya los mandamos en
   * vez de dictarlos de memoria. `false` si el pago es por transferencia y
   * todavía no hay ninguna cuenta cargada en Configuración.
   */
  transfer_details_sent?: boolean;
  /** Solo presente cuando status es 'faltan_datos_cliente' (ver ADR-033). */
  missing_fields?: MissingCustomerField[];
  existing_data?: {
    address: string | null;
    id_document: string | null;
    full_name: string | null;
    municipality: string | null;
    city: string | null;
    phone: string | null;
  } | null;
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
 * `escalation_config`, ver escalationRules.ts) — se evalúa acá, *antes*
 * de insertar el pedido, para que un monto alto nunca llegue a quedar
 * `status: 'confirmed'` ni descuente stock. Antes este chequeo vivía en
 * el orquestador y se aplicaba sobre el resultado de esta misma tool, es
 * decir después de que el pedido ya existía en la base — el cliente
 * recibía el mensaje de escalamiento, pero el pedido real ya estaba
 * confirmado (ver docs/fase-7-escalamiento-humano/reglas-escalamiento.md).
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
  messageSid: string,
  input: CrearPedidoInput,
  montoAltoThreshold: number,
): Promise<CrearPedidoOutput> {
  const idempotencyKey = buildIdempotencyKey(input.quote_id, messageSid);

  const checked = await withTransaction(async (client) => {
    const existing = await client.query<{ id: string; total: string; public_order_number: string }>(
      `SELECT id, total, public_order_number FROM orders WHERE quote_id = $1`,
      [input.quote_id],
    );
    if (existing.rows[0]) {
      return {
        kind: "duplicate" as const,
        order_id: existing.rows[0].id,
        total: Number(existing.rows[0].total),
        publicOrderNumber: existing.rows[0].public_order_number,
      };
    }

    const quoteResult = await client.query<{
      id: string;
      conversation_id: string;
      customer_id: string;
      total: string;
      applied_promotion_id: string | null;
    }>(`SELECT id, conversation_id, customer_id, total, applied_promotion_id FROM quotes WHERE id = $1`, [
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

    // Captura progresiva de datos de entrega (ver ADR-033). La tool nunca
    // reutiliza en silencio los datos ya guardados en `customers` — si el
    // orquestador no manda `customer_data` completo, se niega igual que ya
    // hace con `monto_alto`, devolviendo lo que haya guardado (o null) para
    // que el modelo se lo confirme explícitamente al cliente antes de
    // reintentar.
    if (!input.customer_data) {
      // La fila propia primero; si no tiene datos de entrega, se busca otra
      // identidad de canal del mismo humano por `contact_phone` (Fase 19,
      // Etapa C1). Es el único cruce entre canales que la decisión de producto
      // contempla: la conversación no se mezcla, pero si el cliente ya compró
      // por WhatsApp no se le vuelven a pedir cédula y dirección porque ahora
      // escribió por Instagram. Igual hay que confirmárselos: `existing_data`
      // no confirma nada por sí solo, la tool sigue devolviendo
      // `faltan_datos_cliente`.
      const customerResult = await client.query<{
        address: string | null;
        id_document: string | null;
        full_name: string | null;
        municipality: string | null;
        city: string | null;
        self_contact_phone: string | null;
      }>(
        `SELECT c.address, c.id_document, c.full_name, c.municipality, c.city,
                self.contact_phone AS self_contact_phone
         FROM customers self
         JOIN customers c
           ON c.id = self.id
           OR (self.address IS NULL
               AND self.contact_phone IS NOT NULL
               AND c.contact_phone = self.contact_phone)
         WHERE self.id = $1
         ORDER BY (c.address IS NOT NULL) DESC, (c.id = self.id) DESC, c.created_at DESC
         LIMIT 1`,
        [quote.customer_id],
      );
      const customer = customerResult.rows[0] ?? null;
      const missingFields: MissingCustomerField[] = [];
      if (!customer?.address) missingFields.push("address");
      if (!customer?.id_document) missingFields.push("id_document");
      if (!customer?.full_name) missingFields.push("full_name");
      // Por WhatsApp el teléfono es la dirección del canal y nunca falta. Por
      // Instagram/Messenger no existe hasta que el cliente lo dé, y sin él no
      // hay cómo coordinar la entrega ni cómo reconocerlo si vuelve por otro
      // canal.
      if (!customer?.self_contact_phone) missingFields.push("phone");

      return {
        kind: "faltan_datos_cliente" as const,
        total,
        existingData: customer && {
          address: customer.address,
          id_document: customer.id_document,
          full_name: customer.full_name,
          municipality: customer.municipality,
          city: customer.city,
          phone: customer.self_contact_phone,
        },
        missingFields,
      };
    }

    const cd = input.customer_data;
    if (cd.save_permanently) {
      // COALESCE solo para municipality/city (opcionales, no vienen siempre)
      // — mismo criterio que memory.ts para no pisar con null un dato ya
      // guardado. address/id_document/full_name son obligatorios en
      // customer_data, así que se sobrescriben directo.
      await client.query(
        `UPDATE customers
         SET address = $2, id_document = $3, full_name = $4,
             municipality = COALESCE($5, municipality), city = COALESCE($6, city),
             contact_phone = COALESCE($7, contact_phone)
         WHERE id = $1`,
        [
          quote.customer_id,
          cd.address,
          cd.id_document,
          cd.full_name,
          cd.municipality ?? null,
          cd.city ?? null,
          cd.phone ?? null,
        ],
      );
    }

    return {
      kind: "ok" as const,
      quote,
      total,
      deliverySnapshot: {
        address: cd.address,
        idDocument: cd.id_document,
        fullName: cd.full_name,
        municipality: cd.municipality ?? null,
        city: cd.city ?? null,
      },
    };
  });

  if (checked.kind === "duplicate") {
    return {
      order_id: checked.order_id,
      status: "duplicate",
      total: checked.total,
      public_order_number: checked.publicOrderNumber,
    };
  }
  if (checked.kind === "monto_alto") {
    return { order_id: null, status: "monto_alto", total: checked.total };
  }
  if (checked.kind === "faltan_datos_cliente") {
    return {
      order_id: null,
      status: "faltan_datos_cliente",
      total: checked.total,
      missing_fields: checked.missingFields,
      existing_data: checked.existingData,
    };
  }

  const { quote, total, deliverySnapshot } = checked;

  let paymentLink: { paymentLinkId: string; url: string } | null = null;
  if (input.payment_method === "pago_en_linea") {
    const wompiConfig = await getWompiConfig();
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

  const created = await withTransaction(async (client) => {
    // `orders.status` nace en 'abierto', no 'confirmed' (Fase 15, ver
    // ADR-033) — todo pedido nuevo puede seguir recibiendo productos via
    // agregar_item_pedido antes de despacharse, sin importar el método de
    // pago. El "confirmed" que devuelve esta tool más abajo es el status
    // del OUTPUT (contrato con el LLM, ver CrearPedidoOutput), no el valor
    // de esta columna — son conceptos distintos que hoy coinciden en texto
    // por herencia histórica, no por diseño.
    const order = await client.query<{ id: string; public_order_number: string }>(
      `INSERT INTO orders (quote_id, conversation_id, customer_id, status, payment_method, payment_status, delivery_method, idempotency_key, total, wompi_payment_link_id, delivery_address, delivery_id_document, delivery_full_name, delivery_municipality, delivery_city)
       VALUES ($1, $2, $3, 'abierto', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, public_order_number`,
      [
        input.quote_id,
        quote.conversation_id,
        quote.customer_id,
        input.payment_method,
        paymentLink ? "pendiente" : "pagado",
        input.delivery_method,
        idempotencyKey,
        quote.total,
        paymentLink?.paymentLinkId ?? null,
        deliverySnapshot.address,
        deliverySnapshot.idDocument,
        deliverySnapshot.fullName,
        deliverySnapshot.municipality,
        deliverySnapshot.city,
      ],
    );

    if (!order.rows[0]) {
      // Carrera entre el SELECT y el INSERT (muy improbable en este
      // sistema, el loop del orquestador es secuencial por conversación).
      const raced = await client.query<{ id: string; total: string; public_order_number: string }>(
        `SELECT id, total, public_order_number FROM orders WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      return {
        order_id: raced.rows[0]!.id,
        status: "duplicate" as const,
        total: Number(raced.rows[0]!.total),
        public_order_number: raced.rows[0]!.public_order_number,
      };
    }
    const orderId = order.rows[0].id;
    const publicOrderNumber = order.rows[0].public_order_number;

    await client.query(
      `INSERT INTO order_items (order_id, variant_id, quantity, unit_price)
       SELECT $1, variant_id, quantity, unit_price FROM quote_items WHERE quote_id = $2`,
      [orderId, input.quote_id],
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
       WHERE oi.order_id = $1 AND i.variant_id = oi.variant_id`,
      [orderId],
    );

    // Cotizar no es comprar: la redención de una campaña `once_per_customer`
    // (ver Fase 17, aplicarPromocion.ts) recién se registra acá, al
    // confirmar el pedido — si el cliente cotiza con la campaña aplicada y
    // no compra, la sigue teniendo disponible.
    if (quote.applied_promotion_id) {
      const promo = await client.query<{ type: string; rules: { once_per_customer?: boolean } }>(
        `SELECT type, rules FROM promotions WHERE id = $1`,
        [quote.applied_promotion_id],
      );
      if (promo.rows[0]?.type === "campaña" && promo.rows[0].rules.once_per_customer) {
        await client.query(
          `INSERT INTO promotion_redemptions (promotion_id, customer_id, order_id) VALUES ($1, $2, $3)`,
          [quote.applied_promotion_id, quote.customer_id, orderId],
        );
      }
    }

    return {
      order_id: orderId,
      status: "confirmed" as const,
      total,
      public_order_number: publicOrderNumber,
    };
  });

  // createWompiPaymentLink corre en una conexión propia (fuera de la
  // transacción de arriba) — igual que createHandoffToken en
  // escalarHumano.ts, se llama después de que `withTransaction` ya
  // resolvió (el pedido quedó comprometido/commiteado). Insertarlo
  // *dentro* de la transacción del pedido violaría el FK a `orders`: esa
  // fila todavía no sería visible desde otra conexión hasta el COMMIT.
  if (paymentLink && created.status === "confirmed") {
    await createWompiPaymentLink(created.order_id, paymentLink.paymentLinkId);
    // La URL se le manda al cliente por WhatsApp y hasta ahora moría ahí:
    // solo se guardaba el id del link. Sin ella el panel no puede
    // reabrirla ni reenviarla, que es justo lo que hace falta cuando el
    // cliente dice "no me llegó" (ver migración 0056).
    await guardarPaymentLinkUrl(created.order_id, paymentLink.url);
    return { ...created, payment_link_url: paymentLink.url };
  }

  // Los datos de transferencia van en un mensaje aparte, fuera del turno
  // del LLM y con los valores tal como están guardados — ver el docblock de
  // datosTransferencia.ts para por qué no pueden pasar por el modelo.
  if (input.payment_method === "transferencia" && created.status === "confirmed") {
    const enviados = await enviarDatosTransferencia(
      quote.conversation_id,
      created.public_order_number ?? "",
      created.total,
    );
    return { ...created, transfer_details_sent: enviados };
  }

  return created;
}
