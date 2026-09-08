// Clave de OpenAI configurable desde el panel (Configuración → Modelo de
// IA), BYOK igual que la config de Wompi (0032) y del LLM (0020): cifrada
// en reposo con secretBox.ts (AES-256-GCM). Hoy `media/transcribirAudio.ts`
// (Whisper, transcripción de audio entrante) solo lee OPENAI_API_KEY de
// env — esta columna pasa a ser la fuente de verdad primaria, con env como
// fallback para no romper despliegues que ya la tengan solo por variable
// de entorno.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE settings ADD COLUMN openai_api_key_encrypted text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE settings DROP COLUMN openai_api_key_encrypted;
  `);
};
