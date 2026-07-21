import formbody from "@fastify/formbody";
import Fastify from "fastify";
import { handleInboundWebhook } from "./webhookHandler.js";

/**
 * Fastify se expone vía buildServer() (en vez de arrancar directamente)
 * para poder testear la ruta con `.inject()` sin abrir un puerto real
 * (ver tests/integration/gateway/webhook.test.ts).
 */
export function buildServer() {
  const app = Fastify({ logger: true });

  // Twilio manda application/x-www-form-urlencoded, no JSON.
  app.register(formbody);

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post("/webhooks/whatsapp", async (request, reply) => {
    const params = request.body as Record<string, string>;
    const signature = request.headers["x-twilio-signature"] as string | undefined;
    const result = await handleInboundWebhook(params, signature);
    return reply.status(result.status).send();
  });

  return app;
}
