import formbody from "@fastify/formbody";
import Fastify from "fastify";
import {
  renderHandoffView,
  resolverConversacion,
  tomarConversacion,
} from "../advisor/handoffView.js";
import { handleInboundWebhook } from "./webhookHandler.js";

/**
 * Fastify se expone vía buildServer() (en vez de arrancar directamente)
 * para poder testear la ruta con `.inject()` sin abrir un puerto real
 * (ver tests/integration/gateway/webhook.test.ts). Un solo servidor para
 * todo el monolito: el webhook de Twilio y la vista del asesor (ver
 * src/advisor/) comparten el mismo proceso Fastify.
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

  app.get("/asesor/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const result = await renderHandoffView(token);
    if (!result.html) {
      return reply.status(result.status).send();
    }
    return reply.status(result.status).type("text/html").send(result.html);
  });

  app.post("/asesor/:token/tomar", async (request, reply) => {
    const { token } = request.params as { token: string };
    await tomarConversacion(token);
    return reply.status(303).redirect(`/asesor/${token}`);
  });

  app.post("/asesor/:token/resolver", async (request, reply) => {
    const { token } = request.params as { token: string };
    await resolverConversacion(token);
    return reply.status(303).redirect(`/asesor/${token}`);
  });

  return app;
}
