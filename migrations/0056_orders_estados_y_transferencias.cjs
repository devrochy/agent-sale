// Estados del pedido, enlace de pago guardado y cuentas de transferencia
// (ver docs/fase-16-estado-pedido-pagos-logistica/estados-y-transferencias.md).
//
// DOS EJES, NO UNO. Los estados que se piden mezclan dos ciclos distintos:
// "abierto" y "despachado" son del pedido; "pendiente de pago", "pagado" y
// "rechazado" son del pago. La tabla ya los tenía separados en `status` y
// `payment_status`, y separados se quedan: un pedido puede estar pagado y
// sin despachar, o despachado y sin pagar (contraentrega). Fundirlos en una
// sola columna obligaría a inventar estados combinados ("pagado_despachado")
// que se multiplican solos. El panel muestra UN estado derivado de los dos,
// que es lo que se quiere leer de un vistazo; la base guarda los dos hechos.
//
// `status` nunca tuvo CHECK: se escribía 'abierto' desde crearPedido.ts y
// 'expirado' desde closeExpiredOrders.ts, sin nada que impidiera un typo.
// Ahora lo tiene, y por eso el backfill de abajo importa: cualquier valor
// que no esté en la lista haría fallar la migración.
exports.up = (pgm) => {
  pgm.sql(`
    -- 'confirmed' es el default histórico de la columna (migración 0006) y
    -- quedó en filas viejas anteriores a la Fase 15, que introdujo
    -- 'abierto'. Se normaliza antes de poner el CHECK.
    UPDATE orders SET status = 'abierto' WHERE status = 'confirmed';

    -- Un pedido con guía registrada ya salió: hasta ahora eso solo se
    -- guardaba en shipped_at y el status se quedaba en 'abierto', así que
    -- el despachado no se distinguía del que todavía no sale. Con el
    -- estado ya visible en el panel, esas filas mentirían.
    UPDATE orders SET status = 'despachado'
     WHERE shipped_at IS NOT NULL AND status = 'abierto';

    -- El DEFAULT seguía siendo 'confirmed' (migración 0006): con el CHECK
    -- puesto, cualquier INSERT que no nombrara la columna reventaba.
    -- crearPedido.ts sí la nombra, así que la app no lo notaba — lo
    -- encontró un fixture de test que insertaba sin status.
    ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'abierto';

    ALTER TABLE orders
      ADD CONSTRAINT orders_status_check
      CHECK (status IN ('abierto', 'despachado', 'entregado', 'cancelado', 'expirado'));

    -- 'rechazado' es el que faltaba para poder registrar lo que ya informa
    -- el webhook de Wompi y hasta ahora se descartaba (ver
    -- wompiWebhookHandler.ts: las transacciones no aprobadas se ignoraban).
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
    ALTER TABLE orders
      ADD CONSTRAINT orders_payment_status_check
      CHECK (payment_status IN ('pendiente', 'pagado', 'rechazado'));

    -- La URL del enlace de pago se generaba, se le mandaba al cliente por
    -- WhatsApp y se perdía: solo se guardaba el id del link. Sin ella el
    -- panel no puede reenviarla ni abrirla, que es justo lo que hace falta
    -- cuando el cliente dice "no me llegó".
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS wompi_payment_link_url text;

    -- Cuándo y por qué se movió el pedido por última vez. status_reason
    -- guarda el motivo de un rechazo o una cancelación, que es la única
    -- transición sobre la que después alguien pregunta "¿y esto por qué?".
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_reason text;

    -- Filtrar por estado en el panel recorre la tabla entera; con el volumen
    -- de hoy da igual, pero el índice cuesta nada y evita el day-2.
    CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
    CREATE INDEX IF NOT EXISTS orders_payment_status_idx ON orders (payment_status);
  `);

  // Cuentas a las que el cliente puede transferir (Nequi, Bancolombia,
  // Daviplata…). jsonb y no una tabla propia: es configuración de un
  // singleton que se lee entera y se reescribe entera, igual que
  // `brand_voice_config` (Fase 20) — una tabla acá agregaría un CRUD y dos
  // joins para guardar cuatro líneas de texto que nadie consulta por
  // separado.
  pgm.sql(`
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS transfer_accounts jsonb NOT NULL DEFAULT '[]'::jsonb;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS orders_status_idx;
    DROP INDEX IF EXISTS orders_payment_status_idx;
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
    ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'confirmed';
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
    ALTER TABLE orders
      ADD CONSTRAINT orders_payment_status_check
      CHECK (payment_status IN ('pendiente', 'pagado'));
    ALTER TABLE orders DROP COLUMN IF EXISTS wompi_payment_link_url;
    ALTER TABLE orders DROP COLUMN IF EXISTS status_changed_at;
    ALTER TABLE orders DROP COLUMN IF EXISTS status_reason;
    ALTER TABLE settings DROP COLUMN IF EXISTS transfer_accounts;
  `);
};
