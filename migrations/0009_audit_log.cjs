exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      conversation_id uuid REFERENCES conversations(id),
      actor text NOT NULL,
      action text NOT NULL,
      input jsonb,
      output jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_log_tenant_id_idx ON audit_log(tenant_id);

    -- audit_log es inmutable (solo insert) por diseño (modelo-datos.md, Fase 1).
    CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log es inmutable: % no permitido', TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER audit_log_no_update_delete
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS audit_log;`);
  pgm.sql(`DROP FUNCTION IF EXISTS audit_log_immutable();`);
};
