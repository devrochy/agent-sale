// ADR-032: retira Row Level Security y `tenant_id` de todo el esquema.
//
// 17 tablas tenían política `tenant_isolation` + `tenant_id` (agregadas
// en 0010_rls_policies.cjs en batch, o inline en su propia migración de
// creación para las posteriores a 0010: llm_usage/0023, reviews/0028,
// admins+admin_permissions/0033). 4 de ellas tenían además un UNIQUE
// compuesto con tenant_id que hay que aplanar (no alcanza con dropear la
// columna, el constraint compuesto completo deja de tener sentido).
//
// 4 tablas de resolución de token (admin_sessions, handoff_tokens,
// review_tokens, wompi_payment_links) nunca tuvieron RLS (ver comentarios
// de sus propias migraciones: resolvían el tenant *antes* de que
// existiera una sesión con `app.tenant_id`) pero sí tenían `tenant_id`
// como dato — ya no hace falta, no hay múltiples tenants entre los que
// resolver.
const SIMPLE_TABLES = [
  "conversations",
  "messages",
  "inventory",
  "promotions",
  "quotes",
  "quote_items",
  "order_items",
  "human_agents",
  "handoff_queue",
  "audit_log",
  "llm_usage",
  "reviews",
  "admin_permissions",
];

const TOKEN_TABLES = ["admin_sessions", "handoff_tokens", "review_tokens", "wompi_payment_links"];

exports.up = (pgm) => {
  // Tablas con UNIQUE compuesto que incluye tenant_id — aplanar antes de
  // dropear la columna, si no el constraint completo se cae con ella.
  pgm.sql(`
    ALTER TABLE customers DROP CONSTRAINT customers_tenant_id_phone_number_key;
    ALTER TABLE customers ADD CONSTRAINT customers_phone_number_key UNIQUE (phone_number);
    ALTER TABLE customers DROP COLUMN tenant_id CASCADE;

    ALTER TABLE products DROP CONSTRAINT products_tenant_id_sku_key;
    ALTER TABLE products ADD CONSTRAINT products_sku_key UNIQUE (sku);
    ALTER TABLE products DROP COLUMN tenant_id CASCADE;

    ALTER TABLE orders DROP CONSTRAINT orders_tenant_id_idempotency_key_key;
    ALTER TABLE orders ADD CONSTRAINT orders_idempotency_key_key UNIQUE (idempotency_key);
    ALTER TABLE orders DROP COLUMN tenant_id CASCADE;

    ALTER TABLE admins DROP CONSTRAINT admins_tenant_id_email_key;
    ALTER TABLE admins ADD CONSTRAINT admins_email_key UNIQUE (email);
    ALTER TABLE admins DROP COLUMN tenant_id CASCADE;
  `);

  // Las 4 tablas de arriba + las 13 "simples" comparten política y RLS:
  // dropear política, desactivar RLS, dropear la columna.
  for (const table of ["customers", "products", "orders", "admins", ...SIMPLE_TABLES]) {
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
    pgm.sql(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
  }

  for (const table of SIMPLE_TABLES) {
    pgm.sql(`ALTER TABLE ${table} DROP COLUMN tenant_id CASCADE;`);
  }

  for (const table of TOKEN_TABLES) {
    pgm.sql(`ALTER TABLE ${table} DROP COLUMN tenant_id CASCADE;`);
  }
};

// No reconstruye datos (imposible — la información de a qué tenant
// pertenecía cada fila ya no existe en ningún lado tras el up). Reconstruye
// la FORMA del esquema (columna nullable + policy) por si hace falta
// revertir el DEPLOY sin perder el resto de las filas; cualquier fila
// existente queda con tenant_id NULL, invisible bajo RLS hasta backfillear
// a mano — comportamiento fail-closed, no un bug.
exports.down = (pgm) => {
  for (const table of TOKEN_TABLES) {
    pgm.sql(`ALTER TABLE ${table} ADD COLUMN tenant_id uuid REFERENCES settings(id);`);
  }

  for (const table of [...SIMPLE_TABLES, "customers", "products", "orders", "admins"]) {
    pgm.sql(`ALTER TABLE ${table} ADD COLUMN tenant_id uuid REFERENCES settings(id);`);
    pgm.sql(`
      CREATE POLICY tenant_isolation ON ${table}
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
    `);
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
  }

  pgm.sql(`
    ALTER TABLE customers DROP CONSTRAINT customers_phone_number_key;
    ALTER TABLE customers ADD CONSTRAINT customers_tenant_id_phone_number_key UNIQUE (tenant_id, phone_number);

    ALTER TABLE products DROP CONSTRAINT products_sku_key;
    ALTER TABLE products ADD CONSTRAINT products_tenant_id_sku_key UNIQUE (tenant_id, sku);

    ALTER TABLE orders DROP CONSTRAINT orders_idempotency_key_key;
    ALTER TABLE orders ADD CONSTRAINT orders_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);

    ALTER TABLE admins DROP CONSTRAINT admins_email_key;
    ALTER TABLE admins ADD CONSTRAINT admins_tenant_id_email_key UNIQUE (tenant_id, email);
  `);
};
