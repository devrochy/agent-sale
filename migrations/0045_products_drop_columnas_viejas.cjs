// Fase 14: último paso de la migración de catálogo (ver ADR-026) — una vez
// que `product_variants`/`category_id` ya tienen los datos (migraciones
// 0040/0041) y las 3 tablas que referenciaban `product_id` ya apuntan a
// `variant_id` (0042/0043/0044), se retiran las columnas viejas de
// `products`: `sku`/`price` viven en `product_variants`, `category` (texto
// libre) se reemplaza por `category_id` (árbol).
//
// El down reconstruye la FORMA de las columnas, no necesariamente el dato
// exacto para productos que ya ganaron más de una variante después de esta
// migración (mismo criterio de honestidad que 0036_drop_multitenancy: toma
// una variante representativa por producto, no reconstruye el histórico).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE products DROP COLUMN sku CASCADE;
    ALTER TABLE products DROP COLUMN price CASCADE;
    ALTER TABLE products DROP COLUMN category CASCADE;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE products ADD COLUMN sku text;
    ALTER TABLE products ADD COLUMN price numeric(12, 2);
    ALTER TABLE products ADD COLUMN category text;

    UPDATE products p SET
      sku = pv.sku,
      price = pv.price
    FROM (
      SELECT DISTINCT ON (product_id) product_id, sku, price
      FROM product_variants
      ORDER BY product_id, active DESC, sku
    ) pv
    WHERE pv.product_id = p.id;

    ALTER TABLE products ALTER COLUMN sku SET NOT NULL;
    ALTER TABLE products ALTER COLUMN price SET NOT NULL;
    ALTER TABLE products ADD CONSTRAINT products_sku_key UNIQUE (sku);
  `);
};
