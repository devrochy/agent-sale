// Extiende los motivos de escalamiento válidos con los 2 que introduce la
// Fase 8 (código) — ver docs/fase-8-observabilidad-seguridad/guardrails.md:
// - "guardrail_precio": interno, lo dispara el orquestador (nunca el LLM)
//   cuando la respuesta final no pasa la verificación de precios.
// - "fuera_de_alcance": lo puede elegir el propio LLM (system prompt +
//   tool escalar_a_humano) cuando el cliente insiste en un tema fuera del
//   alcance de ForMotos tras la redirección.
exports.up = (pgm) => {
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
        'fuera_de_alcance'
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
        'queja'
      )
    );
  `);
};
