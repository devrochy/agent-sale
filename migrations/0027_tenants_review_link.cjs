// Fase 12.2 (ver docs/fase-12-capacidades-proactivas-agente/analisis-superpoderes.md,
// #11 Reseñas): link de reseña (ej. Google Business) que se manda junto
// con el agradecimiento de la encuesta cuando la calificación es buena
// (ver src/orchestrator/satisfactionSurvey.ts). Nullable — sin configurar,
// solo se manda el agradecimiento, nunca un link inventado.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants ADD COLUMN review_link text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants DROP COLUMN review_link;
  `);
};
