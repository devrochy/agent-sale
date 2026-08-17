// Fase 11.4 extendida (ver docs/fase-11-panel-admin-dashboard/adrs/
// ADR-021-tono-personalizable-cache-jerarquico.md): tono de voz y estilo de
// mensajes configurables por tenant. NULL = usar los defaults in-code de
// src/orchestrator/behaviorConfig.ts (comportamiento idéntico al actual —
// mismo patrón que escalation_config, ver migrations/0014). Override
// campo-por-campo, sin deep merge.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants ADD COLUMN behavior_config jsonb;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants DROP COLUMN behavior_config;
  `);
};
