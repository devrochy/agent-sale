// Fase 14: separa el producto genérico (lo que el cliente busca) de sus
// variantes concretas (lo que tiene SKU/precio/stock real) — ver ADR-026.
// Todo producto tiene al menos una variante, incluso los que hoy no tienen
// talla/color: se les crea una fila con `attributes = '{}'`, para no
// bifurcar la lógica de precio/stock entre "con variante" y "sin variante"
// en ningún punto del código.
//
// Backfill: no hay catálogo real cargado en ninguna base al momento de esta
// migración (confirmado con el negocio, solo existe el catálogo de prueba
// de `scripts/seed-catalogo-prueba.ts`) — igual se migra cualquier fila que
// exista en `products` en el momento de correr esto, con su `sku`/`price`
// actual.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE product_variants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id uuid NOT NULL REFERENCES products(id),
      sku text NOT NULL UNIQUE,
      attributes jsonb NOT NULL DEFAULT '{}',
      price numeric(12, 2) NOT NULL,
      active boolean NOT NULL DEFAULT true
    );
    CREATE INDEX product_variants_product_id_idx ON product_variants(product_id);

    INSERT INTO product_variants (product_id, sku, price)
    SELECT id, sku, price FROM products;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS product_variants;`);
};
