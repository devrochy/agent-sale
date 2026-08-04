// Fase 16 (ver docs/fase-16-estado-pedido-pagos-logistica/adrs/ADR-034-numero-publico-cierre-automatico-logistica.md):
// número de pedido público para que el cliente pueda preguntar por su
// estado sin exponer el UUID interno, más los campos de logística que
// llena el admin al despachar.
//
// `order_seq` es una secuencia propia (no el UUID `id`, que no es
// secuencial ni corto): se hace backfill en orden de `created_at` para los
// pedidos existentes y luego se le pone DEFAULT nextval(...) para que los
// pedidos nuevos lo obtengan solos, sin lógica de aplicación. Ligada a la
// columna con OWNED BY para que el down la elimine junto con `order_seq`.
//
// `public_order_number` es GENERATED ALWAYS ... STORED: Postgres la deriva
// de `order_seq`, la aplicación nunca la escribe ni compite por generarla.
//
// `tracking_number`/`carrier`/`shipped_at` nullable — `shipped_at` es el
// guard de idempotencia de la notificación de guía (mismo criterio que
// `payment_status = 'pendiente'` en el webhook de Wompi, ver 0030): permite
// corregir el número de guía después sin volver a notificar al cliente.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE SEQUENCE orders_order_seq_seq;

    ALTER TABLE orders ADD COLUMN order_seq integer;

    UPDATE orders o
    SET order_seq = backfill.rn
    FROM (SELECT id, row_number() OVER (ORDER BY created_at) AS rn FROM orders) backfill
    WHERE o.id = backfill.id;

    DO $$
    DECLARE
      max_seq integer;
    BEGIN
      SELECT MAX(order_seq) INTO max_seq FROM orders;
      IF max_seq IS NULL THEN
        PERFORM setval('orders_order_seq_seq', 1, false);
      ELSE
        PERFORM setval('orders_order_seq_seq', max_seq);
      END IF;
    END $$;

    ALTER TABLE orders ALTER COLUMN order_seq SET DEFAULT nextval('orders_order_seq_seq');
    ALTER TABLE orders ALTER COLUMN order_seq SET NOT NULL;
    ALTER TABLE orders ADD CONSTRAINT orders_order_seq_unique UNIQUE (order_seq);
    ALTER SEQUENCE orders_order_seq_seq OWNED BY orders.order_seq;

    ALTER TABLE orders
      ADD COLUMN public_order_number text GENERATED ALWAYS AS ('FM-' || lpad(order_seq::text, 4, '0')) STORED,
      ADD COLUMN tracking_number text,
      ADD COLUMN carrier text,
      ADD COLUMN shipped_at timestamptz;

    ALTER TABLE orders ADD CONSTRAINT orders_public_order_number_unique UNIQUE (public_order_number);

    -- El rol de aplicación (ver migrations/0011_app_role.cjs) no hereda
    -- privilegios sobre secuencias nuevas por ALTER DEFAULT PRIVILEGES (esa
    -- cláusula solo cubre TABLES) — sin este GRANT, cualquier INSERT en
    -- orders falla con "permission denied for sequence" al intentar el
    -- nextval() implícito del DEFAULT de order_seq.
    GRANT USAGE, SELECT ON SEQUENCE orders_order_seq_seq TO agent_sale_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders
      DROP COLUMN public_order_number,
      DROP COLUMN tracking_number,
      DROP COLUMN carrier,
      DROP COLUMN shipped_at,
      DROP COLUMN order_seq;
  `);
};
