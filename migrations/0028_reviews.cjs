// Reseñas propias (ver docs/fase-12-capacidades-proactivas-agente/,
// extensión de #11 tras QA con el usuario): a diferencia del diseño
// original, el texto de la reseña ya no se escribe en Google — se
// captura en una página propia (src/reviews/reviewView.ts) y se guarda
// acá para poder usarla como análisis/estrategia de mercadeo.
//
// `score` se copia de conversations.satisfaction_score al momento de
// guardar (denormalizado, evita join para leer la lista en Analítica).
// `shared_publicly` se marca cuando el cliente hace clic en "compartir en
// Google" DESPUÉS de escribir la reseña interna (ver
// GET /resena/:token/compartir) — el link externo (tenants.review_link)
// pasa a ser un paso posterior opcional, no el destino directo.
//
// Dato de negocio por tenant → RLS explícito, mismo patrón que llm_usage
// (migrations/0023): 0010_rls_policies.cjs solo corrió una vez, contra
// las tablas que existían en ese momento.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE reviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      conversation_id uuid NOT NULL REFERENCES conversations(id),
      customer_id uuid NOT NULL REFERENCES customers(id),
      score integer,
      review_text text NOT NULL,
      shared_publicly boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX reviews_tenant_id_created_at_idx ON reviews (tenant_id, created_at);
    CREATE UNIQUE INDEX reviews_conversation_id_idx ON reviews (conversation_id);

    ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
    ALTER TABLE reviews FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON reviews
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP POLICY IF EXISTS tenant_isolation ON reviews;
    DROP TABLE IF EXISTS reviews;
  `);
};
