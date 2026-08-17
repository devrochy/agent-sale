// El rol que corre las migraciones (superuser en docker-compose local /
// "postgres" gestionado en Supabase) siempre puede saltarse RLS, con o sin
// FORCE ROW LEVEL SECURITY — eso es un comportamiento de Postgres, no un
// bug. Por eso la aplicación NUNCA se conecta con ese rol: se crea un rol
// separado, sin privilegios de superusuario ni BYPASSRLS, que es el único
// que usa `shared/db` (DATABASE_URL). Las migraciones siguen corriendo con
// el rol admin (MIGRATIONS_DATABASE_URL).
exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agent_sale_app') THEN
        CREATE ROLE agent_sale_app LOGIN PASSWORD 'agent_sale_app' NOSUPERUSER NOBYPASSRLS;
      END IF;
    END
    $$;

    GRANT USAGE ON SCHEMA public TO agent_sale_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agent_sale_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agent_sale_app;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM agent_sale_app;`);
  pgm.sql(`DROP ROLE IF EXISTS agent_sale_app;`);
};
