// Enlace único de acceso a la vista del asesor (ver
// docs/fase-7-escalamiento-humano/vista-asesor.md: "acceso simple por
// enlace único, sin sistema de login completo"). Tabla deliberadamente
// SIN RLS, igual que `tenants` (ver migrations/0010_rls_policies.cjs):
// resolver el token es el paso previo a poder abrir una sesión con
// `app.tenant_id` seteado, así que no puede depender de RLS. Solo guarda
// el mínimo necesario para resolver token -> tenant/handoff — nunca datos
// de negocio (eso vive en handoff_queue/conversations, detrás de RLS).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE handoff_tokens (
      token text PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      handoff_id uuid NOT NULL REFERENCES handoff_queue(id),
      human_agent_id uuid REFERENCES human_agents(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS handoff_tokens;`);
};
