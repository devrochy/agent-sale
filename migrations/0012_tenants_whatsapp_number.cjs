// Número de WhatsApp del negocio (no el del cliente, ese vive en
// customers.phone_number). Necesario para que el gateway resuelva
// tenant_id a partir del campo `To` del webhook de Twilio. No estaba en el
// ERD conceptual de modelo-datos.md (Fase 1) — se agrega al implementar el
// gateway real (Fase 3, código). Formato igual al que envía Twilio, ej.
// "whatsapp:+57...", sin normalización adicional.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants ADD COLUMN whatsapp_number text UNIQUE;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE tenants DROP COLUMN IF EXISTS whatsapp_number;`);
};
