// Nombre de marca mostrado en el panel admin, separado del `name`
// operativo del tenant (ver docs/fase-11-panel-admin-dashboard/adrs/
// ADR-016-parametrizacion-marca-tenant.md). Nullable: si un tenant no
// configura nada, el panel usa `tenants.name` como fallback — ForMotos
// no requiere seed, sigue mostrando "ForMotos" tal cual hoy.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants ADD COLUMN display_name text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE tenants DROP COLUMN IF EXISTS display_name;`);
};
