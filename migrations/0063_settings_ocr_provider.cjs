// Proveedor de OCR/visión configurable por panel (comprobantes de pago y
// fotos de producto, ver src/vision/), mismo criterio BYOK que el LLM
// conversacional (migrations/0020) — pero sin ninguna columna legada que
// preservar: hoy no existe ninguna config de OCR guardada en ningún lado,
// `ocr_provider IS NULL` simplemente significa "usar Claude vision con
// env.ANTHROPIC_API_KEY", igual que el comportamiento actual hardcodeado.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE settings
      ADD COLUMN ocr_provider text,
      ADD COLUMN ocr_model text,
      ADD COLUMN ocr_api_key_encrypted text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE settings
      DROP COLUMN ocr_provider,
      DROP COLUMN ocr_model,
      DROP COLUMN ocr_api_key_encrypted;
  `);
};
