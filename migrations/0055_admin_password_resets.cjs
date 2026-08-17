// Recuperación de contraseña del panel (ver
// docs/fase-11-panel-admin-dashboard/contrasena.md).
//
// Se guarda el SHA-256 del token, no el token. `handoff_tokens` y
// `review_tokens` guardan el suyo en claro y para ellos alcanza: dan acceso
// a una conversación concreta y no a la cuenta. Este otro reescribe la
// contraseña de un admin, y el panel ya está publicado en Internet — un
// volcado de esta tabla no puede alcanzar para entrar. El token viaja una
// sola vez, en el enlace que se manda por WhatsApp, y de ahí no vuelve a
// existir en ninguna parte.
//
// `expires_at` y `used_at` son las dos mitades de "un solo uso, y por poco
// tiempo": la primera acota la ventana si el mensaje queda en un celular
// abierto, la segunda impide reutilizar el enlace después de restablecer.
// Ninguno de los tokens que ya existen en el repo tiene expiración; acá sí,
// por la misma razón de arriba.
//
// ON DELETE CASCADE: borrar un admin no debe dejar tokens vivos apuntando a
// un id que ya no existe. Hoy los admins se desactivan en vez de borrarse,
// pero el que un día borre uno no tiene por qué acordarse de esta tabla.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE admin_password_resets (
      token_hash text PRIMARY KEY,
      admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    );

    CREATE INDEX admin_password_resets_admin_id_idx
      ON admin_password_resets (admin_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS admin_password_resets;`);
};
