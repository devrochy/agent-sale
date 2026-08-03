// Fase 13 v2 (ver docs/fase-1-arquitectura/adrs/ADR-032-retiro-multi-tenancy.md,
// sección "Perfil de administrador"): el Reporte del asistente (antes
// "Reporte diario", migrations/0024_tenants_report_recipient.cjs) deja de
// mandarse siempre cada 24h — el usuario elige cada cuántos días quiere
// recibirlo (diario/semanal/mensual/personalizado, ver adminPanel.ts).
//
// `report_frequency_days`: un solo entero en vez de guardar por separado
// la etiqueta ("semanal") y el número de días — la etiqueta se deriva del
// número (1/7/30/otro) en la UI, no hace falta guardarla. Default 1
// preserva el comportamiento actual (diario) para instalaciones existentes
// sin que nadie tenga que reconfigurar nada.
//
// `report_last_sent_at`: para poder saber si "ya toca" mandar el próximo
// (ver sendDailyReports en dailyReport.ts) sin depender de que el cron
// corra exactamente cada N días — el cron sigue corriendo diario
// (scheduler.ts) y compara contra esta marca. `null` = nunca se mandó
// todavía, siempre "toca".
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE settings ADD COLUMN report_frequency_days integer NOT NULL DEFAULT 1;
    ALTER TABLE settings ADD COLUMN report_last_sent_at timestamptz;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE settings DROP COLUMN report_last_sent_at;
    ALTER TABLE settings DROP COLUMN report_frequency_days;
  `);
};
