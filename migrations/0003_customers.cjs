exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE customers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      phone_number text NOT NULL,
      name text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, phone_number)
    );
    CREATE INDEX customers_tenant_id_idx ON customers(tenant_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS customers;`);
};
