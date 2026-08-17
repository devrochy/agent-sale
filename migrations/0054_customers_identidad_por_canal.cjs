// Fase 19, Etapa C1 (ver docs/fase-19-integracion-multicanal/README.md y
// adrs/ADR-029-arquitectura-gateway-multicanal.md): la identidad del cliente
// deja de ser "un telefono" y pasa a ser "una direccion dentro de un canal".
//
// Por que hace falta: IGSID (Instagram) y PSID (Messenger) son identificadores
// opacos por cuenta, no telefonos. El esquema actual asume que si, con
// customers.phone_number NOT NULL UNIQUE.
//
// Decision de producto detras de la forma de la tabla: las conversaciones se
// llevan **separadas por canal** y se responde siempre por donde el cliente
// escribio. No se intenta deducir que el @rob de Instagram y el +57318... de
// WhatsApp son la misma persona: Meta no da ninguna forma de saberlo. Lo que
// si se comparte, cuando el telefono coincide, son los datos de gestion del
// pedido (nombre, cedula, direccion, ciudad).
//
// De ahi el punto clave del esquema: `phone_number` se **renombra** a
// `external_id` en vez de dejarse con el nombre viejo y otro significado.
// Hoy esa columna guarda la direccion del canal (`whatsapp:+57318...`), no un
// telefono, asi que estaba haciendo dos trabajos a la vez. Si se le cambiara
// el sentido sin renombrarla, cualquiera de los ~60 puntos de uso que no se
// revise seguiria funcionando y mandaria mensajes a una direccion mal formada:
// una falla silenciosa. Renombrando, todo uso no migrado falla ruidosamente.
//
// `contact_phone` es el telefono de verdad y **no lleva UNIQUE**: dos
// identidades de canal de la misma persona comparten telefono de forma
// legitima, y es justo esa coincidencia la que permite reusar los datos de
// gestion. Es nullable porque un cliente que entra por Instagram no tiene
// telefono hasta que lo da al comprar.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE customers RENAME COLUMN phone_number TO external_id;

    ALTER TABLE customers
      ADD COLUMN channel text NOT NULL DEFAULT 'whatsapp'
        CHECK (channel IN ('whatsapp', 'instagram', 'messenger')),
      ADD COLUMN contact_phone text;

    -- El telefono real sale de la direccion que ya teniamos: todo lo existente
    -- es WhatsApp y su direccion canonica es 'whatsapp:+E164'.
    UPDATE customers
      SET contact_phone = replace(external_id, 'whatsapp:', '')
      WHERE external_id LIKE 'whatsapp:+%';

    -- La unicidad se mueve de "un telefono en todo el sistema" a "una
    -- direccion dentro de su canal": el mismo humano puede (y va a) existir
    -- como dos filas si escribe por dos canales, y eso es lo buscado.
    ALTER TABLE customers DROP CONSTRAINT customers_phone_number_key;
    ALTER TABLE customers
      ADD CONSTRAINT customers_channel_external_id_key UNIQUE (channel, external_id);

    -- Busqueda de los datos de gestion cuando el telefono coincide entre
    -- canales (el unico cruce que la decision de producto si contempla).
    CREATE INDEX customers_contact_phone_idx ON customers (contact_phone)
      WHERE contact_phone IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX customers_contact_phone_idx;

    -- El esquema viejo no puede representar un cliente que no sea de WhatsApp,
    -- y esas filas no se pueden borrar acá: conversations, orders, quotes,
    -- reviews y promotion_redemptions las referencian. Se corta con un error
    -- explicito en vez de fallar despues por clave foranea o, peor, de borrar
    -- en cascada el historial de un cliente real.
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM customers WHERE channel <> 'whatsapp') THEN
        RAISE EXCEPTION 'Hay clientes de Instagram/Messenger: el esquema anterior no puede representarlos. Migrarlos o borrarlos a mano antes de revertir.';
      END IF;
    END $$;

    ALTER TABLE customers DROP CONSTRAINT customers_channel_external_id_key;
    ALTER TABLE customers ADD CONSTRAINT customers_phone_number_key UNIQUE (external_id);

    ALTER TABLE customers
      DROP COLUMN contact_phone,
      DROP COLUMN channel;

    ALTER TABLE customers RENAME COLUMN external_id TO phone_number;
  `);
};
