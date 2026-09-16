// Cancelación de un pedido YA pagado (ver src/domains/commerce/cancelarPedido.ts):
// ya no cambia orders.status de inmediato — queda "solicitada" acá hasta
// que un admin la aprueba desde el panel, después de gestionar la
// devolución del dinero por fuera del sistema. `cancellation_requested_at
// IS NOT NULL AND status = 'abierto'` es la condición de "cancelación
// pendiente de aprobación".
//
// De paso, agrega "cancelacion_pedido_pagado" a los motivos válidos de
// handoff_queue.reason (mismo patrón que las migraciones 0016/0019) —
// interno, igual que "guardrail_precio"/"guardrail_stock": lo dispara
// cancelarPedido.ts, nunca lo elige el LLM (no está en el enum de la tool
// escalar_a_humano de toolDefinitions.ts).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders
      ADD COLUMN cancellation_requested_at timestamptz,
      ADD COLUMN cancellation_reason text;

    ALTER TABLE handoff_queue DROP CONSTRAINT handoff_queue_reason_check;
    ALTER TABLE handoff_queue ADD CONSTRAINT handoff_queue_reason_check CHECK (
      reason IN (
        'compatibilidad_tecnica',
        'monto_alto',
        'solicitud_cliente',
        'intentos_fallidos',
        'queja',
        'guardrail_precio',
        'fuera_de_alcance',
        'guardrail_stock',
        'cancelacion_pedido_pagado'
      )
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE handoff_queue DROP CONSTRAINT handoff_queue_reason_check;
    ALTER TABLE handoff_queue ADD CONSTRAINT handoff_queue_reason_check CHECK (
      reason IN (
        'compatibilidad_tecnica',
        'monto_alto',
        'solicitud_cliente',
        'intentos_fallidos',
        'queja',
        'guardrail_precio',
        'fuera_de_alcance',
        'guardrail_stock'
      )
    );

    ALTER TABLE orders
      DROP COLUMN cancellation_requested_at,
      DROP COLUMN cancellation_reason;
  `);
};
