import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

// Proveedor de LLM (ver ADR-010): "anthropic" es el elegido para
// producción (ADR-008); "openai_compatible" habilita cualquier API que
// hable el formato de chat completions de OpenAI (DeepSeek, Groq, el
// propio OpenAI) para pruebas reales de bajo costo sin tocar el resto
// del orquestador. Solo se exige la credencial del proveedor realmente
// seleccionado, para no bloquear el arranque con la del otro.
const llmProvider = (process.env.LLM_PROVIDER ?? "anthropic") as "anthropic" | "openai_compatible";

export const env = {
  databaseUrl: required("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  // Nivel de log (ver src/shared/observability/logger.ts, Fase 8) —
  // "info" en producción evita ruido de "debug" sin perder los 8 puntos
  // de tracing por conversation_id (docs/fase-8-observabilidad-seguridad/tracing.md).
  logLevel: process.env.LOG_LEVEL ?? "info",
  // Auth Token de Twilio: clave de verificación de firma de webhooks
  // (ver docs/fase-3-whatsapp-gateway/webhook-contrato.md). Requerido:
  // sin esto el gateway no puede validar ningún webhook entrante.
  twilioAuthToken: required("TWILIO_AUTH_TOKEN"),
  // URL pública exacta registrada en la consola de Twilio para el
  // webhook — se usa fija en vez de reconstruirla de headers de request
  // para no depender de cómo un proxy (Fly.io) reescribe host/proto.
  publicWebhookUrl: required("PUBLIC_WEBHOOK_URL"),
  // El orchestrator los necesita para enviar la respuesta del agente
  // (ver src/gateway/sendMessage.ts) — sin cuenta real de Twilio esto no
  // se puede probar en vivo, pero el código ya los requiere.
  twilioAccountSid: required("TWILIO_ACCOUNT_SID"),
  twilioWhatsappNumber: required("TWILIO_WHATSAPP_NUMBER"),
  // Credenciales del panel admin de solo lectura (ver src/admin/adminPanel.ts)
  // — no hay sistema de login en el proyecto, Basic Auth con estas
  // credenciales es la única protección de /admin/*.
  adminUser: required("ADMIN_USER"),
  adminPassword: required("ADMIN_PASSWORD"),
  // Clave maestra para cifrar las API keys que un tenant trae propias
  // (BYOK, Fase 11.4 — ver src/shared/crypto/secretBox.ts y ADR-020).
  // Distinta categoría de secreto que las de arriba (ADR-007): esas son
  // credenciales operativas de la plataforma, esta es la clave con la que
  // ciframos credenciales que el tenant nos entrega.
  tenantSecretsEncryptionKey: required("TENANT_SECRETS_ENCRYPTION_KEY"),
  llmProvider,
  // Clave de la API de Claude (ver ADR-008, Fase 4) — solo requerida si
  // ese es el proveedor activo.
  anthropicApiKey: llmProvider === "anthropic" ? required("ANTHROPIC_API_KEY") : (process.env.ANTHROPIC_API_KEY ?? ""),
  // Config del proveedor openai_compatible (ver ADR-010). Los defaults
  // apuntan a DeepSeek: cambiar de proveedor real solo requiere setear
  // LLM_PROVIDER=openai_compatible y LLM_API_KEY.
  llmBaseUrl: process.env.LLM_BASE_URL ?? "https://api.deepseek.com",
  llmModel: process.env.LLM_MODEL ?? "deepseek-chat",
  llmApiKey: llmProvider === "openai_compatible" ? required("LLM_API_KEY") : (process.env.LLM_API_KEY ?? ""),
  // Key de sistema para Gemini (Fase 11.4, catálogo configurable por
  // tenant — ver catalog.ts) — opcional a propósito: Gemini nunca es el
  // proveedor default de la plataforma, así que un tenant que lo elige
  // sin traer su propia key (BYOK) depende de que esta exista; si no,
  // resolveLlmProviderForTenant falla con un mensaje claro en vez de
  // bloquear el arranque de todo el proceso por una key que puede no
  // hacer falta nunca.
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
};
