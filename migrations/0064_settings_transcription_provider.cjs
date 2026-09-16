// Proveedor de transcripción de audio configurable por panel (Groq como
// alternativa a OpenAI Whisper, ver src/media/), mismo criterio BYOK que
// el LLM/OCR — pero a diferencia de esos dos, aquí SÍ hay una columna
// legada que preservar: `openai_api_key_encrypted` (migración 0061) ya es
// la key BYOK real de instalaciones existentes. No se toca ni se migra
// esa columna — `resolveTranscriptionProvider` (src/media/) lee ambas y
// sintetiza el resultado en tiempo de lectura si `transcription_provider`
// está vacío pero la key legada tiene valor, así ninguna instalación que
// ya configuró Whisper por panel se rompe con este deploy.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE settings
      ADD COLUMN transcription_provider text,
      ADD COLUMN transcription_model text,
      ADD COLUMN transcription_api_key_encrypted text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE settings
      DROP COLUMN transcription_provider,
      DROP COLUMN transcription_model,
      DROP COLUMN transcription_api_key_encrypted;
  `);
};
