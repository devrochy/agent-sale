// Confirmación de domicilio antes de despachar (pedido del usuario: la
// plantilla "confirmar_domicilio" con botón de respuesta rápida, ver
// cerrarPedido.ts/registrarGuia.ts).
//
// `NULL` = sin confirmar — es el estado de todo pedido nuevo y también el de
// cualquier pedido creado ANTES de esta migración: no hay forma real de
// saber si esa dirección vieja sigue vigente, así que no se asume que sí.
// `registrarGuia.ts` exige esta columna no nula antes de aceptar una guía.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS address_confirmed_at timestamptz;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE orders DROP COLUMN IF EXISTS address_confirmed_at;
  `);
};
