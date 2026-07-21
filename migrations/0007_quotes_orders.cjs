exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE quotes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      conversation_id uuid NOT NULL REFERENCES conversations(id),
      customer_id uuid NOT NULL REFERENCES customers(id),
      subtotal numeric(12, 2) NOT NULL DEFAULT 0,
      discount numeric(12, 2) NOT NULL DEFAULT 0,
      total numeric(12, 2) NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'draft',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX quotes_tenant_id_idx ON quotes(tenant_id);

    -- quote_items.tenant_id denormalizado desde quotes (ver nota en messages,
    -- migración 0004) para RLS uniforme.
    CREATE TABLE quote_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      quote_id uuid NOT NULL REFERENCES quotes(id),
      product_id uuid NOT NULL REFERENCES products(id),
      quantity integer NOT NULL CHECK (quantity > 0),
      unit_price numeric(12, 2) NOT NULL
    );
    CREATE INDEX quote_items_tenant_id_idx ON quote_items(tenant_id);
    CREATE INDEX quote_items_quote_id_idx ON quote_items(quote_id);

    CREATE TABLE orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      quote_id uuid NOT NULL REFERENCES quotes(id),
      conversation_id uuid NOT NULL REFERENCES conversations(id),
      customer_id uuid NOT NULL REFERENCES customers(id),
      status text NOT NULL DEFAULT 'confirmed',
      payment_method text NOT NULL CHECK (
        payment_method IN ('transferencia', 'efectivo_contraentrega', 'tarjeta')
      ),
      delivery_method text NOT NULL CHECK (
        delivery_method IN ('domicilio', 'recoger_en_tienda')
      ),
      idempotency_key text NOT NULL,
      total numeric(12, 2) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, idempotency_key)
    );
    CREATE INDEX orders_tenant_id_idx ON orders(tenant_id);

    CREATE TABLE order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      order_id uuid NOT NULL REFERENCES orders(id),
      product_id uuid NOT NULL REFERENCES products(id),
      quantity integer NOT NULL CHECK (quantity > 0),
      unit_price numeric(12, 2) NOT NULL
    );
    CREATE INDEX order_items_tenant_id_idx ON order_items(tenant_id);
    CREATE INDEX order_items_order_id_idx ON order_items(order_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS order_items;`);
  pgm.sql(`DROP TABLE IF EXISTS orders;`);
  pgm.sql(`DROP TABLE IF EXISTS quote_items;`);
  pgm.sql(`DROP TABLE IF EXISTS quotes;`);
};
