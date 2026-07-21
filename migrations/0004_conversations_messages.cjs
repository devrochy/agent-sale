exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      customer_id uuid NOT NULL REFERENCES customers(id),
      status text NOT NULL DEFAULT 'open',
      state jsonb NOT NULL DEFAULT '{}'::jsonb,
      started_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz
    );
    CREATE INDEX conversations_tenant_id_idx ON conversations(tenant_id);

    -- messages.tenant_id se denormaliza desde conversations para poder aplicar
    -- la misma política RLS uniforme (multi-tenant-rls.md exige tenant_id en
    -- toda tabla de negocio); el ERD conceptual de la Fase 1 lo omitía.
    CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      conversation_id uuid NOT NULL REFERENCES conversations(id),
      direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      sender_type text NOT NULL CHECK (sender_type IN ('customer', 'agent', 'human')),
      content text NOT NULL,
      tool_calls jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX messages_tenant_id_idx ON messages(tenant_id);
    CREATE INDEX messages_conversation_id_idx ON messages(conversation_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS messages;`);
  pgm.sql(`DROP TABLE IF EXISTS conversations;`);
};
