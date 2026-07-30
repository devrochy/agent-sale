// Fase 11.4 extendida (ver docs/fase-11-panel-admin-dashboard/adrs/
// ADR-023-ruteo-automatico-dificultad.md): "Cerebro del bot" — modo de
// ruteo del modelo dentro del proveedor ya elegido (ver llm_provider,
// migración 0020). 'manual' (default) = comportamiento de ADR-020, usa
// llm_model tal cual. 'auto_dificultad' = el modelo se elige por turno
// según una heurística de dificultad, ignorando llm_model. Columna
// simple (no jsonb, como bot_paused): es un flag de 2 valores, tightly
// acoplado a llm_provider/llm_model, no un ajuste de comportamiento
// genérico como behavior_config.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants ADD COLUMN llm_routing_mode text NOT NULL DEFAULT 'manual';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants DROP COLUMN llm_routing_mode;
  `);
};
