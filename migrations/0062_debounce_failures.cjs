// Fase 2 del plan de remediación del incidente 2026-09-13 (ver ADR-022):
// si el turno diferido por "velocidad de respuesta" (debounceScheduler.ts,
// fireConversation) agota sus reintentos, antes solo quedaba un log de
// error — nadie se enteraba salvo que revisara Loki a mano. Esta tabla es
// el mínimo viable para que el fallo quede consultable (y, más adelante,
// visible en el panel admin) en vez de perderse en el log.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE debounce_failures (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id uuid REFERENCES conversations(id),
      error_message text NOT NULL,
      attempts integer NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz
    );

    -- La consulta real es siempre "qué falló y sigue sin resolver" — un
    -- índice parcial evita escanear filas ya atendidas.
    CREATE INDEX debounce_failures_unresolved_idx
      ON debounce_failures (occurred_at)
      WHERE resolved_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS debounce_failures;`);
};
