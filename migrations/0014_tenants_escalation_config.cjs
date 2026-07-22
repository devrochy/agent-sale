// Umbrales de escalamiento configurables por tenant (ver
// docs/fase-7-escalamiento-humano/reglas-escalamiento.md: "el número de
// intentos fallidos, la lista de palabras clave, y el umbral de monto
// alto se leen de configuración por tenant, no como valores fijos en el
// código"). No existía ninguna columna para esto en el modelo de datos
// de la Fase 1 — se agrega al implementar el escalamiento real (Fase 7,
// código). Nullable: si un tenant no configuró nada, el orquestador usa
// los defaults de src/orchestrator/escalationRules.ts.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants ADD COLUMN escalation_config jsonb;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE tenants DROP COLUMN IF EXISTS escalation_config;`);
};
