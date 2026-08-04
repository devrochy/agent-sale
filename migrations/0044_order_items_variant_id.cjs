// Fase 14: `order_items` pasa a referenciar `variant_id` en vez de
// `product_id` — ver ADR-026, 0042 y 0043 (mismo patrón, última de las 3
// tablas migradas antes de poder dropear `sku`/`price`/`category` de
// `products` en la migración 0045).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE order_items ADD COLUMN variant_id uuid REFERENCES product_variants(id);
    UPDATE order_items oi SET variant_id = pv.id
      FROM product_variants pv WHERE pv.product_id = oi.product_id;
    ALTER TABLE order_items ALTER COLUMN variant_id SET NOT NULL;
    ALTER TABLE order_items DROP COLUMN product_id CASCADE;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE order_items ADD COLUMN product_id uuid REFERENCES products(id);
    UPDATE order_items oi SET product_id = pv.product_id
      FROM product_variants pv WHERE pv.id = oi.variant_id;
    ALTER TABLE order_items ALTER COLUMN product_id SET NOT NULL;
    ALTER TABLE order_items DROP COLUMN variant_id CASCADE;
  `);
};
