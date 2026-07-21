exports.up = (pgm) => {
  pgm.sql(`
    -- embedding sin dimensión fija: el modelo de embeddings para
    -- recomendar_producto se decide en el incremento de Fase 6 (código).
    CREATE TABLE products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      sku text NOT NULL,
      name text NOT NULL,
      category text,
      price numeric(12, 2) NOT NULL,
      embedding vector,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, sku)
    );
    CREATE INDEX products_tenant_id_idx ON products(tenant_id);

    CREATE TABLE inventory (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      product_id uuid NOT NULL REFERENCES products(id),
      stock_quantity integer NOT NULL DEFAULT 0,
      source text NOT NULL DEFAULT 'manual',
      last_synced_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX inventory_tenant_id_idx ON inventory(tenant_id);
    CREATE INDEX inventory_product_id_idx ON inventory(product_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS inventory;`);
  pgm.sql(`DROP TABLE IF EXISTS products;`);
};
