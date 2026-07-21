// La tool escalar_a_humano (docs/fase-1-arquitectura/contratos-tools.md)
// recibe un `summary` para el asesor, pero handoff_queue no tenía dónde
// guardarlo — se agrega al implementar el orquestador (Fase 4, código).
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE handoff_queue ADD COLUMN summary text;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE handoff_queue DROP COLUMN IF EXISTS summary;`);
};
