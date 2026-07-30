// Correlación payment_link_id -> tenant/pedido (Fase 12.4, ver ADR-024).
// Tabla deliberadamente SIN RLS, mismo criterio que handoff_tokens
// (migrations/0015) y review_tokens (migrations/0029): el webhook de
// Wompi (wompiWebhookHandler.ts) llega sin saber a qué tenant pertenece —
// resolver `payment_link_id` acá es el paso previo a poder abrir una
// sesión con `app.tenant_id` seteado, así que no puede depender de RLS.
// Solo guarda el mínimo para resolver link -> tenant/order — el estado
// real del pago vive en `orders`, detrás de RLS.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE wompi_payment_links (
      payment_link_id text PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      order_id uuid NOT NULL REFERENCES orders(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS wompi_payment_links;`);
};
