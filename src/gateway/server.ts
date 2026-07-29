import crypto from "node:crypto";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import {
  renderHandoffView,
  resolverConversacion,
  tomarConversacion,
} from "../advisor/handoffView.js";
import {
  renderOverviewPage,
  renderPedidosPage,
  renderProductosPage,
  renderTenantsPage,
} from "../admin/adminPanel.js";
import { env } from "../config/env.js";
import { logger } from "../shared/observability/logger.js";
import { handleInboundWebhook } from "./webhookHandler.js";

/**
 * Compara dos strings con largo variable en tiempo constante cuando
 * coinciden en longitud (timingSafeEqual lanza si no coinciden, y un
 * largo distinto ya es suficiente para saber que no son iguales — no
 * hace falta timing-safe para esa rama).
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Fastify se expone vía buildServer() (en vez de arrancar directamente)
 * para poder testear la ruta con `.inject()` sin abrir un puerto real
 * (ver tests/integration/gateway/webhook.test.ts). Un solo servidor para
 * todo el monolito: el webhook de Twilio y la vista del asesor (ver
 * src/advisor/) comparten el mismo proceso Fastify.
 */
export async function buildServer() {
  // `loggerInstance` (no `logger`) es la opción de Fastify 5 para pasar
  // una instancia pino ya construida — así los access logs HTTP salen en
  // el mismo JSON estructurado que el resto de la app (ver
  // src/shared/observability/logger.ts, Fase 8).
  const app = Fastify({ loggerInstance: logger });

  // Twilio manda application/x-www-form-urlencoded, no JSON.
  await app.register(formbody);

  // Rate limiting por IP (ver docs/fase-8-observabilidad-seguridad/revision-seguridad.md,
  // "Controles nuevos de esta fase"): protege contra abuso o un error de
  // configuración del lado de Twilio. Por IP, no por tenant — el tenant
  // no se conoce hasta después de verificar firma y resolver el número;
  // limitar por tenant queda fuera de alcance mientras el piloto sea de
  // un solo tenant (ForMotos). El registro se espera explícitamente: sin
  // el `await`, el hook global de rate limiting no queda activo a tiempo
  // para las rutas que se declaran a continuación.
  await app.register(rateLimit, { max: 200, timeWindow: "1 minute" });

  app.get("/healthz", async () => ({ status: "ok" }));

  // Panel admin de solo lectura (catálogo/pedidos, ver src/admin/adminPanel.ts):
  // no hay sistema de login en el proyecto, Basic Auth con ADMIN_USER/ADMIN_PASSWORD
  // es la única protección de este prefijo.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/admin")) {
      return;
    }
    const expected = `Basic ${Buffer.from(`${env.adminUser}:${env.adminPassword}`).toString("base64")}`;
    const header = request.headers.authorization;
    if (!header || !safeEqual(header, expected)) {
      reply.header("WWW-Authenticate", 'Basic realm="admin"');
      return reply.status(401).send();
    }
  });

  app.get("/admin", async (_request, reply) => {
    const html = await renderTenantsPage();
    return reply.type("text/html").send(html);
  });

  app.get("/admin/:tenantId", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const html = await renderOverviewPage(tenantId);
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/:tenantId/productos", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const html = await renderProductosPage(tenantId);
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/:tenantId/pedidos", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const html = await renderPedidosPage(tenantId);
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.post(
    "/webhooks/whatsapp",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const params = request.body as Record<string, string>;
      const signature = request.headers["x-twilio-signature"] as string | undefined;
      const result = await handleInboundWebhook(params, signature);
      return reply.status(result.status).send();
    },
  );

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
