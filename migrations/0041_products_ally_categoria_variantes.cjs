// Fase 14: `products` gana las columnas del producto genérico (ver
// ADR-026) — `ally_id` obligatorio (default: aliado genérico sembrado en
// la migración 0039), `category_id` (nodo hoja de `product_categories`,
// nullable hasta que se le asigne una) y `has_variants` (si tiene más de
// una variante activa, chequeado por el agente antes de cotizar — ver
// systemPrompt.ts).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE products ADD COLUMN ally_id uuid REFERENCES allies(id);
    UPDATE products SET ally_id = (SELECT id FROM allies WHERE name = 'Catálogo propio');
    ALTER TABLE products ALTER COLUMN ally_id SET NOT NULL;

    ALTER TABLE products ADD COLUMN category_id uuid REFERENCES product_categories(id);
    ALTER TABLE products ADD COLUMN has_variants boolean NOT NULL DEFAULT false;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE products DROP COLUMN has_variants;
    ALTER TABLE products DROP COLUMN category_id;
    ALTER TABLE products DROP COLUMN ally_id;
  `);
};
