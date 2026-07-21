// Política RLS estándar (multi-tenant-rls.md, ADR-004): toda tabla de
// negocio con tenant_id queda protegida. `tenants` queda deliberadamente
// fuera: es el directorio raíz que el gateway consulta para resolver el
// tenant_id a partir del número de WhatsApp entrante, antes de que exista
// un `app.tenant_id` en sesión.
const TENANT_SCOPED_TABLES = [
  "customers",
  "conversations",
  "messages",
  "products",
  "inventory",
  "promotions",
  "quotes",
  "quote_items",
  "orders",
  "order_items",
  "human_agents",
  "handoff_queue",
  "audit_log",
];

exports.up = (pgm) => {
  for (const table of TENANT_SCOPED_TABLES) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    // FORCE es necesario porque el rol de aplicación es dueño de las tablas
    // (creadas por la propia migración) — sin FORCE, RLS no aplicaría al
    // dueño y el test de aislamiento pasaría en falso.
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`
      CREATE POLICY tenant_isolation ON ${table}
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
    `);
  }
};

exports.down = (pgm) => {
  for (const table of TENANT_SCOPED_TABLES) {
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
    pgm.sql(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
  }
};
