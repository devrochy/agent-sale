// Agrega "guardrail_stock" a los motivos válidos de escalamiento — Fase
// 12.1 (ver docs/fase-12-capacidades-proactivas-agente/
// analisis-superpoderes.md, superpoder #1): extiende el guardrail
// determinístico de precios (Fase 8, migración 0016) a disponibilidad.
// Interno, igual que "guardrail_precio": lo dispara el orquestador
// (priceGuardrail.ts), nunca lo elige el LLM.
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
        'fuera_de_alcance',
        'guardrail_stock'
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
        'fuera_de_alcance'
      )
    );
  `);
};
