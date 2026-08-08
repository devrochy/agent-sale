// Fase 19, Etapa A (ver docs/fase-19-integracion-multicanal/README.md y
// adrs/ADR-029-arquitectura-gateway-multicanal.md): base para operar el
// gateway sobre una matriz canal x proveedor, en vez del acoplamiento actual
// a Twilio como unico camino posible.
//
// Dos ejes, no uno: un mismo canal (whatsapp) puede tener mas de un
// proveedor (twilio, meta) activo a la vez, y cada conversacion recuerda por
// cual entro para responder por ahi mismo.
//
// Notas de diseno que la forma de la tabla hace cumplir:
//
// - La unicidad real es sobre la clave de ruteo entrante, UNIQUE(provider,
//   external_id), no sobre (channel, provider): esta ultima prohibiria dos
//   numeros de Twilio (ventas + soporte, o el periodo de migracion de un
//   numero a otro) y dos cuentas de Instagram cuando llegue la Etapa C.
//   `external_id` es lo que matchea el webhook — para Twilio es el campo
//   `To`, para Meta sera `metadata.phone_number_id`, que no es un telefono.
//   `display_address` es aparte porque es lo que se muestra en el panel.
//
// - `is_primary` (la conexion que se usa cuando no hay conversacion de por
//   medio, ej. notificaciones a administradores) se garantiza con un indice
//   unico parcial, no por convencion. El repo ya arrastra el singleton sin
//   constraint de `settings` (UPDATE sin WHERE en settingsDirectory.ts, mas
//   un baile de guardar/restaurar en los tests de integracion) y no vale la
//   pena repetir ese patron.
//
// - Las credenciales van como un unico blob JSON cifrado con secretBox.ts
//   (mismo primitivo que ya usan Wompi y el BYOK del LLM) porque cada
//   proveedor tiene campos distintos: Twilio necesita accountSid/authToken,
//   Meta necesitara appSecret/accessToken/verifyToken. Un blob mantiene el
//   esquema estable al agregar proveedores.
//
// La tabla nace vacia a proposito: la fila de Twilio la siembra
// `ensureConnectionsFromEnv()` al arrancar el proceso, no esta migracion.
// node-pg-migrate corre con MIGRATIONS_DATABASE_URL (otro rol, posiblemente
// otro job en Fly) y puede no tener ni los secretos de Twilio ni
// TENANT_SECRETS_ENCRYPTION_KEY; ademas, cifrar desde un .cjs obligaria a
// duplicar el formato `iv:authTag:ciphertext` de secretBox.ts en un segundo
// lugar.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE channel_connections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      channel text NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'messenger')),
      provider text NOT NULL CHECK (provider IN ('twilio', 'meta')),
      label text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      is_primary boolean NOT NULL DEFAULT false,
      external_id text NOT NULL,
      display_address text,
      credentials_encrypted text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider, external_id)
    );

    CREATE UNIQUE INDEX channel_connections_una_primary_por_canal
      ON channel_connections (channel) WHERE is_primary;

    ALTER TABLE conversations
      ADD COLUMN channel text NOT NULL DEFAULT 'whatsapp'
        CHECK (channel IN ('whatsapp', 'instagram', 'messenger')),
      ADD COLUMN connection_id uuid REFERENCES channel_connections(id);

    CREATE INDEX conversations_connection_id_idx ON conversations (connection_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX conversations_connection_id_idx;

    ALTER TABLE conversations
      DROP COLUMN connection_id,
      DROP COLUMN channel;

    DROP INDEX channel_connections_una_primary_por_canal;

    DROP TABLE channel_connections;
  `);
};
