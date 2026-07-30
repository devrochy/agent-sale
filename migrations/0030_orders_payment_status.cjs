// Cobros por WhatsApp con Wompi (Fase 12.4, ver
// docs/fase-12-capacidades-proactivas-agente/adrs/ADR-024-cobros-wompi-confirmacion-automatica.md).
//
// `payment_status` separado de `status`: hoy los 3 métodos existentes
// (transferencia/efectivo_contraentrega/tarjeta) no tienen verificación
// digital — crearPedido.ts los marca 'confirmed' incondicionalmente. Para
// no tocar ese comportamiento, `payment_status` nace en 'pagado' por
// default (equivalente a "el sistema no verifica esto, lo asume"); solo el
// nuevo método 'pago_en_linea' nace en 'pendiente' y pasa a 'pagado' recién
// cuando el webhook de Wompi confirma la transacción (ver
// wompiWebhookHandler.ts). `wompi_payment_link_id`/`wompi_transaction_id`
// nullable — solo se llenan para pedidos con `pago_en_linea`.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders
      ADD COLUMN payment_status text NOT NULL DEFAULT 'pagado'
        CHECK (payment_status IN ('pendiente', 'pagado')),
      ADD COLUMN paid_at timestamptz,
      ADD COLUMN wompi_payment_link_id text,
      ADD COLUMN wompi_transaction_id text;

    ALTER TABLE orders DROP CONSTRAINT orders_payment_method_check;
    ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
      CHECK (payment_method IN ('transferencia', 'efectivo_contraentrega', 'tarjeta', 'pago_en_linea'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders DROP CONSTRAINT orders_payment_method_check;
    ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
      CHECK (payment_method IN ('transferencia', 'efectivo_contraentrega', 'tarjeta'));

    ALTER TABLE orders
      DROP COLUMN payment_status,
      DROP COLUMN paid_at,
      DROP COLUMN wompi_payment_link_id,
      DROP COLUMN wompi_transaction_id;
  `);
};
