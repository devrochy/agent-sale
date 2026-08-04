// Fase 15 (ver docs/fase-15-datos-cliente-flujo-pedidos/adrs/ADR-033-datos-entrega-y-pedido-abierto.md):
// captura progresiva de dirección/cédula/nombre de entrega, requerida por
// crear_pedido antes de confirmar un pedido nuevo.
//
// `customers.*` es el dato "de perfil" (persiste si el cliente elige
// guardarlo permanentemente). `orders.delivery_*` es un snapshot propio de
// cada pedido — lo usado en ESE pedido puntual, independiente de que el
// cliente actualice después su perfil. Todas nullable: pedidos/clientes
// anteriores a esta migración simplemente no las tienen.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE customers
      ADD COLUMN address text,
      ADD COLUMN id_document text,
      ADD COLUMN full_name text,
      ADD COLUMN municipality text,
      ADD COLUMN city text;

    ALTER TABLE orders
      ADD COLUMN delivery_address text,
      ADD COLUMN delivery_id_document text,
      ADD COLUMN delivery_full_name text,
      ADD COLUMN delivery_municipality text,
      ADD COLUMN delivery_city text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders
      DROP COLUMN delivery_address,
      DROP COLUMN delivery_id_document,
      DROP COLUMN delivery_full_name,
      DROP COLUMN delivery_municipality,
      DROP COLUMN delivery_city;

    ALTER TABLE customers
      DROP COLUMN address,
      DROP COLUMN id_document,
      DROP COLUMN full_name,
      DROP COLUMN municipality,
      DROP COLUMN city;
  `);
};
