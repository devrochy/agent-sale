// Fase 20 (ver docs/fase-20-voz-marca-rag/README.md y
// adrs/ADR-030-rag-institucional-tercer-bloque-cache-y-diagnostico-bug.md):
// tercer bloque de "system" - voz de marca + RAG institucional
// (mision/vision/valores), texto libre por negocio (a diferencia del tono
// de ADR-021, no hay variantes fijas razonables aca). Mismo patron que
// settings.behavior_config (migrations/0021): jsonb, sin merge parcial,
// se sobrescribe entero en cada guardado.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE settings ADD COLUMN brand_voice_config jsonb;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE settings DROP COLUMN brand_voice_config;
  `);
};
