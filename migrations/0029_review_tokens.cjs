// Enlace único de acceso a la página de reseña (ver src/reviews/reviewView.ts)
// — mismo criterio exacto que handoff_tokens (migrations/0015): tabla
// deliberadamente SIN RLS, porque resolver el token es el paso previo a
// poder abrir una sesión con `app.tenant_id` seteado, así que no puede
// depender de RLS. Solo guarda el mínimo necesario para resolver
// token -> tenant/conversation — nunca el texto de la reseña en sí (eso
// vive en `reviews`, detrás de RLS).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE review_tokens (
      token text PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      conversation_id uuid NOT NULL REFERENCES conversations(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS review_tokens;`);
};
