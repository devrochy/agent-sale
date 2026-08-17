// Fase 12.2 (ver docs/fase-12-capacidades-proactivas-agente/analisis-superpoderes.md,
// #7 Reporte diario, y ADR-018 infraestructura-jobs-programados): número de
// WhatsApp del lado del negocio que recibe el resumen diario. Nullable a
// propósito — sin `report_recipient_phone` configurado, sendDailyReports()
// simplemente no le manda reporte a ese tenant (no es un error). No se
// reutiliza `human_agents` (esa tabla es para notificaciones de
// escalamiento, un rol distinto — el usuario decidió mantenerlos
// separados).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants ADD COLUMN report_recipient_phone text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants DROP COLUMN report_recipient_phone;
  `);
};
