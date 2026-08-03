// Fase 13 (ver ADR-025): las notificaciones a colaboradores (reporte
// diario, pago aprobado, tickets nuevos) son por WhatsApp, igual que el
// resto de la mensajería proactiva del proyecto (dailyReport.ts,
// ADR-024) — `admins` necesita un teléfono al que mandarlas, no solo
// email/password para el login. Nullable: un admin puede existir sin
// teléfono (usa el panel pero no recibe WhatsApp); ese caso simplemente
// no recibe notificaciones, no es un error (mismo criterio que
// `tenants.report_recipient_phone`, migrations/0024).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE admins ADD COLUMN phone text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE admins DROP COLUMN phone;
  `);
};
