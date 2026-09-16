// Recordatorio de comprobante de transferencia pendiente (ver
// src/jobs/recordarComprobantePendiente.ts) — mismo rol que
// quotes.follow_up_sent_at (migración 0025): marca que ya se le mandó el
// recordatorio a este pedido, para no repetirlo en cada corrida del job.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders ADD COLUMN comprobante_reminder_sent_at timestamptz;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders DROP COLUMN comprobante_reminder_sent_at;
  `);
};
