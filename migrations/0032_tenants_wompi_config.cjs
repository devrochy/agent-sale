// Config BYOK de Wompi por tenant (Fase 12.4, ver ADR-024) — mismo patrón
// que la config de LLM (ADR-020): cada tenant trae su propia cuenta de
// Wompi, cifrada en reposo con secretBox.ts (AES-256-GCM). Sin llaves de
// plataforma en env.ts — no hay una cuenta de Wompi compartida entre
// tenants. `wompi_events_secret_encrypted` se usa solo para verificar la
// firma de los webhooks entrantes (wompiSignature.ts), nunca para llamar
// a la API de Wompi.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants
      ADD COLUMN wompi_private_key_encrypted text,
      ADD COLUMN wompi_events_secret_encrypted text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants
      DROP COLUMN wompi_private_key_encrypted,
      DROP COLUMN wompi_events_secret_encrypted;
  `);
};
