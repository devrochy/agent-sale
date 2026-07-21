exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE human_agents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      name text NOT NULL,
      contact text NOT NULL,
      active boolean NOT NULL DEFAULT true
    );
    CREATE INDEX human_agents_tenant_id_idx ON human_agents(tenant_id);

    CREATE TABLE handoff_queue (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      conversation_id uuid NOT NULL REFERENCES conversations(id),
      reason text NOT NULL CHECK (
        reason IN (
          'compatibilidad_tecnica',
          'monto_alto',
          'solicitud_cliente',
          'intentos_fallidos',
          'queja'
        )
      ),
      status text NOT NULL DEFAULT 'queued',
      assigned_to uuid REFERENCES human_agents(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz
    );
    CREATE INDEX handoff_queue_tenant_id_idx ON handoff_queue(tenant_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS handoff_queue;`);
  pgm.sql(`DROP TABLE IF EXISTS human_agents;`);
};
