// Fase 14: `inventory` pasa a referenciar la variante concreta (SKU real),
// no el producto genérico — ver ADR-026. Backfill trivial: cada fila de
// `inventory` apuntaba a un `product_id` que ahora tiene exactamente una
// `product_variants` (creada 1:1 en la migración 0040), así que el join es
// directo sin ambigüedad.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE inventory ADD COLUMN variant_id uuid REFERENCES product_variants(id);
    UPDATE inventory i SET variant_id = pv.id
      FROM product_variants pv WHERE pv.product_id = i.product_id;
    ALTER TABLE inventory ALTER COLUMN variant_id SET NOT NULL;

    DROP INDEX IF EXISTS inventory_product_id_idx;
    ALTER TABLE inventory DROP COLUMN product_id CASCADE;
    CREATE INDEX inventory_variant_id_idx ON inventory(variant_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE inventory ADD COLUMN product_id uuid REFERENCES products(id);
    UPDATE inventory i SET product_id = pv.product_id
      FROM product_variants pv WHERE pv.id = i.variant_id;
    ALTER TABLE inventory ALTER COLUMN product_id SET NOT NULL;

    DROP INDEX IF EXISTS inventory_variant_id_idx;
    ALTER TABLE inventory DROP COLUMN variant_id CASCADE;
    CREATE INDEX inventory_product_id_idx ON inventory(product_id);
  `);
};
