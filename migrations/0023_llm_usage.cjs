// Fase 11.5 (ver docs/fase-11-panel-admin-dashboard/analitica-costos.md y
// ADR-017-persistencia-uso-llm-postgres.md): espejo de negocio del uso de
// LLM por turno, insert best-effort junto al log
// `orchestrator.llm_completado` (ver src/orchestrator/loop.ts) — el log a
// Loki sigue siendo la fuente de verdad operacional, esta tabla es para
// costo/tokens cruzados con datos de negocio en el panel admin.
//
// `provider`/`model` ya vienen resueltos por `resolveLlmProviderForTenant`
// (ADR-020/021/023) — el hueco que ADR-017 dejaba pendiente ("de dónde
// sale `model`") queda cerrado gratis, sin inferencia manual.
//
// Tabla creada DESPUÉS de migrations/0010_rls_policies.cjs (que solo
// corrió una vez contra las tablas que existían en ese momento) — necesita
// su propio ENABLE/FORCE ROW LEVEL SECURITY + policy, mismo patrón exacto.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE llm_usage (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      conversation_id uuid REFERENCES conversations(id),
      provider text NOT NULL,
      model text NOT NULL,
      input_tokens integer NOT NULL,
      output_tokens integer NOT NULL,
      latency_ms integer NOT NULL,
      cost_usd numeric(10,6),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX llm_usage_tenant_id_created_at_idx ON llm_usage (tenant_id, created_at);

    ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY;
    ALTER TABLE llm_usage FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON llm_usage
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP POLICY IF EXISTS tenant_isolation ON llm_usage;
    DROP TABLE IF EXISTS llm_usage;
  `);
};
