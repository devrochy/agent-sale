// Fase 17 (ver docs/fase-17-motor-promociones-avanzado/adrs/ADR-027-elegibilidad-multidimension-y-clasificacion-cliente.md):
// el motor de promociones (Fase 6, aplicarPromocion.ts) hoy evalúa
// `volumen`/`temporada` sobre TODAS las promociones activas, sin ninguna
// dimensión de elegibilidad. Estas columnas son nuevos filtros opcionales
// (todas nullable) que acotan qué cotización puede optar a una promoción
// — nunca cambian el "se aplica una sola, la de mayor beneficio" ya
// aceptado en Fase 6, ni el comportamiento de las promociones existentes
// de volumen/temporada (que no las usan).
//
// `include_child_categories` default true: el caso más común al crear una
// promoción de categoría es que aplique también a sus subcategorías (ver
// árbol de product_categories, Fase 14).
//
// `type = 'campaña'`: tipo nuevo para promociones puntuales tipo "15% de
// bienvenida", generalmente `once_per_customer` (ver `rules` jsonb,
// evaluado en aplicarPromocion.ts) — se controla con `promotion_redemptions`,
// no con la constraint.
//
// `quotes.applied_promotion_id`: registra qué promoción (si alguna) quedó
// aplicada a esa cotización — lo escribe aplicarPromocion.ts y lo lee
// crearPedido.ts al confirmar el pedido, para saber si hay que insertar una
// redención. Se guarda en la cotización (no en el pedido) porque cotizar no
// es comprar: si el cliente no confirma, la promoción sigue disponible.
//
// `promotion_redemptions`: una fila por pedido confirmado que usó una
// promoción de tipo `campaña` con `once_per_customer` — permite el chequeo
// de "¿ya la usó este cliente?" en aplicarPromocion.ts.
//
// `settings.customer_recurrente_min_pedidos` / `customer_fiel_min_pedidos`:
// umbrales de clasificación de cliente (`nuevo`/`recurrente`/`fiel`, ver
// ADR-027). Ya no existe `tenants`/multi-tenancy (ADR-032) — van en el
// singleton `settings`, mismo patrón que `report_frequency_days`
// (migrations/0038_settings_reporte_frecuencia.cjs). Defaults conservadores,
// sin validar todavía contra datos reales de ForMotos (mismo criterio que
// el umbral de "monto alto" de Fase 7).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE promotions
      ADD COLUMN ally_id uuid REFERENCES allies(id),
      ADD COLUMN category_id uuid REFERENCES product_categories(id),
      ADD COLUMN include_child_categories boolean NOT NULL DEFAULT true,
      ADD COLUMN product_id uuid REFERENCES products(id),
      ADD COLUMN variant_id uuid REFERENCES product_variants(id),
      ADD COLUMN eligible_segments text[];

    ALTER TABLE promotions DROP CONSTRAINT promotions_type_check;
    ALTER TABLE promotions ADD CONSTRAINT promotions_type_check
      CHECK (type IN ('temporada', 'volumen', 'campaña'));

    ALTER TABLE quotes ADD COLUMN applied_promotion_id uuid REFERENCES promotions(id);

    CREATE TABLE promotion_redemptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      promotion_id uuid NOT NULL REFERENCES promotions(id),
      customer_id uuid NOT NULL REFERENCES customers(id),
      order_id uuid NOT NULL REFERENCES orders(id),
      redeemed_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX promotion_redemptions_promotion_customer_idx
      ON promotion_redemptions(promotion_id, customer_id);

    ALTER TABLE settings ADD COLUMN customer_recurrente_min_pedidos integer NOT NULL DEFAULT 2;
    ALTER TABLE settings ADD COLUMN customer_fiel_min_pedidos integer NOT NULL DEFAULT 5;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE settings DROP COLUMN customer_fiel_min_pedidos;
    ALTER TABLE settings DROP COLUMN customer_recurrente_min_pedidos;

    DROP TABLE promotion_redemptions;

    ALTER TABLE quotes DROP COLUMN applied_promotion_id;

    ALTER TABLE promotions DROP CONSTRAINT promotions_type_check;
    ALTER TABLE promotions ADD CONSTRAINT promotions_type_check
      CHECK (type IN ('temporada', 'volumen'));

    ALTER TABLE promotions
      DROP COLUMN eligible_segments,
      DROP COLUMN variant_id,
      DROP COLUMN product_id,
      DROP COLUMN include_child_categories,
      DROP COLUMN category_id,
      DROP COLUMN ally_id;
  `);
};
