// Fase 12.2 (ver docs/fase-12-capacidades-proactivas-agente/analisis-superpoderes.md,
// #3 Cazador de ventas, y ADR-019 mensajeria-proactiva-ventana-24h): marca
// cuándo se le mandó el mensaje de reenganche a una cotización sin pedido
// confirmado — evita reenganchar dos veces la misma. Nullable: solo se
// marca cuando el envío no lanzó (ver src/jobs/cazadorDeVentas.ts); un
// fallo real de envío deja la columna en null para que el job la
// reintente en la próxima corrida mientras siga en la ventana de 3-20h.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE quotes ADD COLUMN follow_up_sent_at timestamptz;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE quotes DROP COLUMN follow_up_sent_at;
  `);
};
