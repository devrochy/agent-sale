// Fase 14: `quote_items` pasa a referenciar `variant_id` en vez de
// `product_id` — ver ADR-026 y 0042 (mismo patrón, aplicado a la tabla que
// arma `generar_cotizacion`).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE quote_items ADD COLUMN variant_id uuid REFERENCES product_variants(id);
    UPDATE quote_items qi SET variant_id = pv.id
      FROM product_variants pv WHERE pv.product_id = qi.product_id;
    ALTER TABLE quote_items ALTER COLUMN variant_id SET NOT NULL;
    ALTER TABLE quote_items DROP COLUMN product_id CASCADE;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE quote_items ADD COLUMN product_id uuid REFERENCES products(id);
    UPDATE quote_items qi SET product_id = pv.product_id
      FROM product_variants pv WHERE pv.id = qi.variant_id;
    ALTER TABLE quote_items ALTER COLUMN product_id SET NOT NULL;
    ALTER TABLE quote_items DROP COLUMN variant_id CASCADE;
  `);
};
