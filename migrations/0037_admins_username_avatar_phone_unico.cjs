// Fase 13 v2 (ver docs/fase-1-arquitectura/adrs/ADR-032-retiro-multi-tenancy.md,
// sección "Perfil de administrador"): con multi-tenancy fuera (migraciones
// 0035/0036), el login pasa a admitir username O correo, y cada admin
// gana un perfil propio editable (avatar, teléfono).
//
// `username` se agrega `NOT NULL UNIQUE` directo, sin backfill: todavía no
// hay admins reales en producción (piloto controlado), cualquier admin de
// prueba local se recrea con el username incluido desde el alta.
//
// `avatar_data`: data URL base64 (`data:image/...;base64,...`), nullable —
// sin avatar cargado se muestran las iniciales en el nav (ver
// adminPanel.ts). No hay integración de storage de objetos en el proyecto
// hoy (`products.image_url` es solo texto con una URL externa) — agregar
// un proveedor de storage es una decisión de infraestructura aparte que
// nadie pidió; el límite de tamaño (~300 KB) se valida en el form, no acá.
//
// `phone` ya existía (migrations/0034), nullable — gana UNIQUE: varios
// `NULL` conviven sin conflicto (comportamiento estándar de Postgres para
// UNIQUE), solo un valor cargado debe ser único.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE admins ADD COLUMN username text NOT NULL UNIQUE;
    ALTER TABLE admins ADD COLUMN avatar_data text;
    ALTER TABLE admins ADD CONSTRAINT admins_phone_key UNIQUE (phone);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE admins DROP CONSTRAINT admins_phone_key;
    ALTER TABLE admins DROP COLUMN avatar_data;
    ALTER TABLE admins DROP COLUMN username;
  `);
};
