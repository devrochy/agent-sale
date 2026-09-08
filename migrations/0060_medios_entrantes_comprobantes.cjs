// Ingesta de medios de WhatsApp (imagen/audio) y comprobantes de
// transferencia (ver docs del plan de "medios entrantes" — comprobante con
// OCR, búsqueda por foto, audio de entrada). No hay storage de objetos en
// el proyecto (decisión previa documentada en la migración 0037: "nadie lo
// pidió") — se reusa el único precedente que hay (`admins.avatar_data`,
// base64 inline en Postgres) en vez de agregar infraestructura nueva.
//
// `inbound_media` es genérica (sirve tanto para el comprobante de pago como
// para una futura foto de producto o un audio) — no le pertenece a ninguna
// de las 3 features, por eso vive sola y no colgada de `orders`.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE inbound_media (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id uuid NOT NULL REFERENCES conversations(id),
      kind text NOT NULL CHECK (kind IN ('image', 'audio')),
      mime_type text NOT NULL,
      data_base64 text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX inbound_media_conversation_idx ON inbound_media (conversation_id);

    -- Cuántas veces se le pidió al cliente que reenvíe un comprobante
    -- legible antes de escalar a un admin (ver procesarComprobante.ts).
    -- Nace en 0 con cada pedido; no tiene sentido resetearla entre pedidos
    -- distintos del mismo cliente.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS comprobante_intentos integer NOT NULL DEFAULT 0;

    -- Un registro por CADA intento de comprobante (no solo el último) — para
    -- que el panel pueda mostrar el historial completo si un admin necesita
    -- entender por qué se rechazó dos veces antes de escalar.
    CREATE TABLE payment_receipts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id),
      inbound_media_id uuid NOT NULL REFERENCES inbound_media(id),
      -- Lo que el OCR pudo leer, tal cual — NULL si la imagen no era legible.
      ocr_monto numeric,
      ocr_cuenta text,
      resultado text NOT NULL CHECK (
        resultado IN (
          'aprobado_auto',
          'rechazado_auto',
          'pendiente_revision',
          'aprobado_admin',
          'rechazado_admin'
        )
      ),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX payment_receipts_order_idx ON payment_receipts (order_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS payment_receipts;
    ALTER TABLE orders DROP COLUMN IF EXISTS comprobante_intentos;
    DROP TABLE IF EXISTS inbound_media;
  `);
};
