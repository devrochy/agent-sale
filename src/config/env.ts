import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno requerida: ${name}`);
  }
  return value;
}

export const env = {
  databaseUrl: required("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  // Auth Token de Twilio: clave de verificación de firma de webhooks
  // (ver docs/fase-3-whatsapp-gateway/webhook-contrato.md). Requerido:
  // sin esto el gateway no puede validar ningún webhook entrante.
  twilioAuthToken: required("TWILIO_AUTH_TOKEN"),
  // URL pública exacta registrada en la consola de Twilio para el
  // webhook — se usa fija en vez de reconstruirla de headers de request
  // para no depender de cómo un proxy (Fly.io) reescribe host/proto.
  publicWebhookUrl: required("PUBLIC_WEBHOOK_URL"),
  // Sin uso todavía en este incremento (envío saliente llega con el
  // orchestrator, Fase 4) — opcionales para no forzar credenciales que
  // aún no existen (cuenta real de Twilio pendiente).
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
  twilioWhatsappNumber: process.env.TWILIO_WHATSAPP_NUMBER,
};
