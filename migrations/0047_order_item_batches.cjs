// Fase 15 (ver docs/fase-15-datos-cliente-flujo-pedidos/adrs/ADR-033-datos-entrega-y-pedido-abierto.md):
// idempotencia propia de la tool agregar_item_pedido. Un pedido `abierto`
// puede recibir N lotes de items en momentos distintos — por eso esta tabla
// vive a nivel de "lote" (un intento de agregar_item_pedido), no a nivel de
// pedido completo como `orders.idempotency_key`. Mismo mecanismo
// (idempotency_key UNIQUE + ON CONFLICT DO NOTHING) que ya usa `orders`.
//
// Sin RLS — mismo criterio que wompi_payment_links (migrations/0031): ya no
// hay multi-tenancy que proteger (ver ADR-032).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE order_item_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id),
      idempotency_key text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS order_item_batches;`);
};
