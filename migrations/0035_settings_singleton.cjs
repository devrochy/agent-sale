// ADR-032 (docs/fase-1-arquitectura/adrs/ADR-032-retiro-multi-tenancy.md):
// agent-sale deja de ser multi-tenant. `tenants` (una fila por PyME
// cliente, ver ADR-004, superada) pasa a ser `settings` — una única fila
// con la configuración del negocio. Se conservan todos los datos/columnas
// tal cual (whatsapp_number, escalation_config, display_name, bot_paused,
// llm_*, behavior_config, report_recipient_phone, review_link,
// wompi_*_encrypted — agregadas incrementalmente en migraciones 0012 a
// 0032), solo cambia el nombre de la tabla.
//
// `plan` (agregada en 0002_tenants.cjs) se dropea acá: nunca se leyó ni
// se escribió en ningún punto de la aplicación — era vestigio de un
// concepto de "plan/tier" de negocio que nunca se implementó. No hace
// falta mantenerla ahora que no hay más de un negocio que "planificar".
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants RENAME TO settings;
    ALTER TABLE settings DROP COLUMN plan;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE settings ADD COLUMN plan text;
    ALTER TABLE settings RENAME TO tenants;
  `);
};
