// Detalle de producto para informar al cliente por WhatsApp (ver
// docs/fase-5-catalogo-inventario): el catálogo real todavía no tiene
// estos datos cargados, por eso son nullable y sin backfill — el script
// de siembra de prueba (scripts/seed-catalogo-prueba.ts) sí los llena.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE products ADD COLUMN description text;
    ALTER TABLE products ADD COLUMN image_url text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE products DROP COLUMN IF EXISTS image_url;
    ALTER TABLE products DROP COLUMN IF EXISTS description;
  `);
};
