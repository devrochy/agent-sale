// Fase 14 (ver docs/fase-14-catalogo-extendido/adrs/ADR-026-*.md): primer
// paso del esquema de catálogo extendido. Sin `tenant_id` en ninguna tabla
// (ADR-032/migración 0036 ya retiró multi-tenancy de todo el sistema).
//
// `allies`: proveedores externos (ej. "Ramos"). Se siembra un aliado
// genérico ("Catálogo propio") para todo producto propio de ForMotos — así
// `products.ally_id` puede ser NOT NULL (migración 0041) sin bifurcar
// "con aliado" / "sin aliado" en ningún punto del código de promociones
// (Fase 17).
//
// `product_categories`: árbol auto-referenciado (`parent_id`), profundidad
// libre — reemplaza `products.category` (texto plano), que se retira en la
// migración 0044 una vez que el catálogo ya tiene `category_id` asignado.
//
// `category_complements`: reemplaza el mapa hardcodeado
// `COMPLEMENTARY_CATEGORIES` de `recomendarProducto.ts` — administrable
// desde el panel (`/admin/categorias`, PR 2 de la fase) en vez de vivir en
// código. Se siembran ambas direcciones explícitamente al marcar dos
// categorías como complementarias (sin depender de un OR simétrico en cada
// query).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE allies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      contact_info text,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO allies (name) VALUES ('Catálogo propio');

    CREATE TABLE product_categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_id uuid REFERENCES product_categories(id),
      name text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true
    );
    CREATE INDEX product_categories_parent_id_idx ON product_categories(parent_id);

    CREATE TABLE category_complements (
      category_id uuid NOT NULL REFERENCES product_categories(id),
      complementary_category_id uuid NOT NULL REFERENCES product_categories(id),
      PRIMARY KEY (category_id, complementary_category_id)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS category_complements;`);
  pgm.sql(`DROP TABLE IF EXISTS product_categories;`);
  pgm.sql(`DROP TABLE IF EXISTS allies;`);
};
