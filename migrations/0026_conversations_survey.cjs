// Fase 12.2 (ver docs/fase-12-capacidades-proactivas-agente/analisis-superpoderes.md,
// #9 Encuestas de satisfacción, y ADR-019 mensajeria-proactiva-ventana-24h):
// tres columnas nullable para el ciclo completo de una encuesta enviada al
// cerrar una conversación (ver src/orchestrator/satisfactionSurvey.ts):
//   - survey_sent_at: se marca al mandar la pregunta al cerrar.
//   - survey_reply_processed_at: se marca la PRIMERA vez que se revisa un
//     mensaje entrante del cliente buscando la respuesta — haya o no
//     calificación reconocible. Es lo que evita reprocesar mensajes
//     futuros no relacionados como si fueran la respuesta de la encuesta
//     (un solo intento por conversación cerrada).
//   - satisfaction_score: solo se llena si el mensaje traía una
//     calificación 1-5 reconocible.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE conversations ADD COLUMN survey_sent_at timestamptz;
    ALTER TABLE conversations ADD COLUMN survey_reply_processed_at timestamptz;
    ALTER TABLE conversations ADD COLUMN satisfaction_score integer;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE conversations DROP COLUMN survey_sent_at;
    ALTER TABLE conversations DROP COLUMN survey_reply_processed_at;
    ALTER TABLE conversations DROP COLUMN satisfaction_score;
  `);
};
