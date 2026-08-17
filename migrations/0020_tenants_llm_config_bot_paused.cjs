// Fase 11.4 (ver docs/fase-11-panel-admin-dashboard/configuracion-comportamiento.md
// y adrs/ADR-020-proveedor-modelo-configurable-byok.md):
// - bot_paused: kill-switch por tenant, chequeado en consumer.ts antes de
//   invocar el orquestador.
// - llm_provider/llm_model: NULL = usar el default de plataforma
//   (env.LLM_PROVIDER/LLM_MODEL, comportamiento idéntico al actual). Con
//   valor, referencia una entrada del catálogo (src/orchestrator/llm/catalog.ts).
// - llm_api_key_encrypted: BYOK — NULL = usar la key del sistema para ese
//   proveedor (solo existe realmente para el proveedor que ya es el default
//   de plataforma). Cifrado con AES-256-GCM (src/shared/crypto/secretBox.ts),
//   nunca en texto plano.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants ADD COLUMN bot_paused boolean NOT NULL DEFAULT false;
    ALTER TABLE tenants ADD COLUMN llm_provider text;
    ALTER TABLE tenants ADD COLUMN llm_model text;
    ALTER TABLE tenants ADD COLUMN llm_api_key_encrypted text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants DROP COLUMN bot_paused;
    ALTER TABLE tenants DROP COLUMN llm_provider;
    ALTER TABLE tenants DROP COLUMN llm_model;
    ALTER TABLE tenants DROP COLUMN llm_api_key_encrypted;
  `);
};
