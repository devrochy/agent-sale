exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE promotions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      type text NOT NULL CHECK (type IN ('temporada', 'volumen')),
      rules jsonb NOT NULL,
      valid_from date,
      valid_to date,
      active boolean NOT NULL DEFAULT true
    );
    CREATE INDEX promotions_tenant_id_idx ON promotions(tenant_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS promotions;`);
};
