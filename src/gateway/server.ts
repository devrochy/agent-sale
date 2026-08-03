import fastifyCookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import {
  renderHandoffView,
  resolverConversacion,
  tomarConversacion,
} from "../advisor/handoffView.js";
import {
  activarColaborador,
  crearColaborador,
  desactivarColaborador,
  exportLeadsCsv,
  guardarCobros,
  guardarComportamiento,
  guardarModeloIa,
  guardarPermisosColaborador,
  guardarReporteDiario,
  guardarReviewLink,
  pausarBot,
  reactivarBot,
  renderAdminRootPage,
  renderAnaliticaPage,
  renderColaboradoresPage,
  renderConexionesPage,
  renderConfiguracionPage,
  renderConversacionesPage,
  renderFlujoPage,
  renderLeadsPage,
  renderLoginPage,
  renderOverviewPage,
  renderPedidosPage,
  renderProductosPage,
  renderTicketsPage,
} from "../admin/adminPanel.js";
import type { AdminRecord } from "../admin/auth/adminsDirectory.js";
import { currentAdmin, SESSION_COOKIE_NAME } from "../admin/auth/currentAdmin.js";
import { login, logout } from "../admin/auth/session.js";
import { renderReviewForm, shareReviewPublicly, submitReview } from "../reviews/reviewView.js";
import { logger } from "../shared/observability/logger.js";
import { handleInboundWebhook } from "./webhookHandler.js";
import { handleWompiWebhook } from "./wompiWebhookHandler.js";

declare module "fastify" {
  interface FastifyRequest {
    // Seteado por el hook de auth de /admin/:tenantId/* (ver más abajo) —
    // null en cualquier ruta pública (webhooks, /asesor, /resena, /admin
    // bare, /admin/:tenantId/login).
    admin: AdminRecord | null;
  }
}

// UUID con guiones — mismo patrón que UUID_PATTERN de withTenant.ts, acá
// solo para reconocer el segmento :tenantId de la URL en el hook global
// de auth (que corre antes de que Fastify resuelva request.params).
const ADMIN_TENANT_PATH = /^\/admin\/([0-9a-f-]{36})(\/[^?]*)?/i;

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

  // Cookies sin firmar (ver src/admin/auth/currentAdmin.ts) — el token de
  // sesión ya es el secreto, validado contra `admin_sessions` en Postgres.
  await app.register(fastifyCookie);
  app.decorateRequest("admin", null);

  // Panel admin (Fase 13, ver src/admin/auth/session.ts y ADR-025):
  // Basic Auth global quedó retirado. Todo `/admin/:tenantId/*` requiere
  // sesión válida, excepto el propio login. `/admin` sin tenantId no
  // expone datos (ver renderAdminRootPage), así que no requiere sesión.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/admin")) {
      return;
    }

    const match = request.url.match(ADMIN_TENANT_PATH);
    if (!match) {
      return; // GET /admin (bare) — sin datos de tenant.
    }

    const tenantId = match[1]!;
    const path = match[2] ?? "";
    if (path === "/login") {
      return; // formulario/acción de login, públicos por definición.
    }

    const admin = await currentAdmin(request, tenantId);
    if (!admin) {
      return reply.status(303).redirect(`/admin/${tenantId}/login`);
    }
    request.admin = admin;
  });

  // Colaboradores (Fase 13, ver ADR-025) — el hook de arriba solo exige
  // sesión válida, no `role='master'`; esa restricción es específica de
  // esta sección, así que se chequea acá, no en el hook global.
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.match(/^\/admin\/[0-9a-f-]{36}\/colaboradores/i)) {
      return;
    }
    if (request.admin?.role !== "master") {
      return reply.status(403).send("Solo un administrador master puede gestionar colaboradores.");
    }
  });

  app.get("/admin", async (_request, reply) => {
    const html = await renderAdminRootPage();
    return reply.type("text/html").send(html);
  });

  app.get("/admin/:tenantId/login", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const html = await renderLoginPage(tenantId);
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.post("/admin/:tenantId/login", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const { email, password } = request.body as { email?: string; password?: string };
    const token =
      email && password ? await login(tenantId, email, password) : null;

    if (!token) {
      const html = await renderLoginPage(tenantId, "Correo o contraseña incorrectos.");
      if (!html) {
        return reply.status(404).send();
      }
      return reply.status(401).type("text/html").send(html);
    }

    reply.setCookie(SESSION_COOKIE_NAME, token, {
      path: `/admin/${tenantId}`,
      httpOnly: true,
      sameSite: "lax",
      secure: request.protocol === "https",
      maxAge: 7 * 24 * 60 * 60,
    });
    return reply.status(303).redirect(`/admin/${tenantId}`);
  });

  app.post("/admin/:tenantId/logout", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    if (token) {
      await logout(token);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: `/admin/${tenantId}` });
    return reply.status(303).redirect(`/admin/${tenantId}/login`);
  });

  app.get("/admin/:tenantId", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const html = await renderOverviewPage(tenantId, request.admin?.role === "master");
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/:tenantId/conversaciones", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const { estado, c } = request.query as { estado?: string; c?: string };
    const html = await renderConversacionesPage(
      tenantId,
      estado,
      c,
      request.admin?.role === "master",
    );
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/:tenantId/leads", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const html = await renderLeadsPage(tenantId, request.admin?.role === "master");
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/:tenantId/leads.csv", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const csv = await exportLeadsCsv(tenantId);
    if (csv === null) {
      return reply.status(404).send();
    }
    return reply
      .type("text/csv")
      .header("content-disposition", 'attachment; filename="leads.csv"')
      .send(csv);
  });

  app.get("/admin/:tenantId/tickets", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const html = await renderTicketsPage(tenantId, request.admin?.role === "master");
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/:tenantId/analitica", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const { moneda } = request.query as { moneda?: string };
    const html = await renderAnaliticaPage(tenantId, moneda, request.admin?.role === "master");
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/:tenantId/flujo", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const html = await renderFlujoPage(tenantId, request.admin?.role === "master");
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/:tenantId/conexiones", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const html = await renderConexionesPage(tenantId, request.admin?.role === "master");
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/:tenantId/colaboradores", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const { error, guardado } = request.query as { error?: string; guardado?: string };
    const html = await renderColaboradoresPage(tenantId, request.admin!.id, { error, guardado });
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.post("/admin/:tenantId/colaboradores", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const { email, password, role } = request.body as {
      email?: string;
      password?: string;
      role?: string;
    };
    const result = await crearColaborador(tenantId, {
      email: email ?? "",
      password: password ?? "",
      role: role ?? "",
    });
    const redirectUrl = result.ok
      ? `/admin/${tenantId}/colaboradores?guardado=1`
      : `/admin/${tenantId}/colaboradores?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/:tenantId/colaboradores/:adminId/activar", async (request, reply) => {
    const { tenantId, adminId } = request.params as { tenantId: string; adminId: string };
    await activarColaborador(tenantId, adminId);
    return reply.status(303).redirect(`/admin/${tenantId}/colaboradores?guardado=1`);
  });

  app.post("/admin/:tenantId/colaboradores/:adminId/desactivar", async (request, reply) => {
    const { tenantId, adminId } = request.params as { tenantId: string; adminId: string };
    await desactivarColaborador(tenantId, adminId);
    return reply.status(303).redirect(`/admin/${tenantId}/colaboradores?guardado=1`);
  });

  app.post("/admin/:tenantId/colaboradores/:adminId/permisos", async (request, reply) => {
    const { tenantId, adminId } = request.params as { tenantId: string; adminId: string };
    const body = request.body as Record<string, string | undefined>;
    await guardarPermisosColaborador(tenantId, adminId, {
      recibeReporteDiario: body.recibeReporteDiario === "on",
      recibeTickets: body.recibeTickets === "on",
      recibeNotificacionPagos: body.recibeNotificacionPagos === "on",
    });
    return reply.status(303).redirect(`/admin/${tenantId}/colaboradores?guardado=1`);
  });

  app.get("/admin/:tenantId/configuracion", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const { error, guardado } = request.query as { error?: string; guardado?: string };
    const html = await renderConfiguracionPage(
      tenantId,
      { error, guardado },
      request.admin?.role === "master",
    );
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.post("/admin/:tenantId/configuracion/pausar", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    await pausarBot(tenantId);
    return reply.status(303).redirect(`/admin/${tenantId}/configuracion`);
  });

  app.post("/admin/:tenantId/configuracion/reactivar", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    await reactivarBot(tenantId);
    return reply.status(303).redirect(`/admin/${tenantId}/configuracion`);
  });

  app.post("/admin/:tenantId/configuracion/modelo-ia", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const { provider, model, apiKey, routingMode } = request.body as {
      provider?: string;
      model?: string;
      apiKey?: string;
      routingMode?: string;
    };
    const result = await guardarModeloIa(tenantId, {
      provider: provider ?? "",
      model: model ?? "",
      apiKey: apiKey ?? "",
      routingMode: routingMode ?? "",
    });
    const redirectUrl = result.ok
      ? `/admin/${tenantId}/configuracion?guardado=1`
      : `/admin/${tenantId}/configuracion?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/:tenantId/configuracion/comportamiento", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const { tono, estiloMensajes, velocidadRespuesta } = request.body as {
      tono?: string;
      estiloMensajes?: string;
      velocidadRespuesta?: string;
    };
    const result = await guardarComportamiento(tenantId, {
      tono: tono ?? "",
      estiloMensajes: estiloMensajes ?? "",
      velocidadRespuesta: velocidadRespuesta ?? "",
    });
    const redirectUrl = result.ok
      ? `/admin/${tenantId}/configuracion?guardado=1`
      : `/admin/${tenantId}/configuracion?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/:tenantId/configuracion/reporte-diario", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const { telefono } = request.body as { telefono?: string };
    const result = await guardarReporteDiario(tenantId, { telefono: telefono ?? "" });
    const redirectUrl = result.ok
      ? `/admin/${tenantId}/configuracion?guardado=1`
      : `/admin/${tenantId}/configuracion?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/:tenantId/configuracion/resenas", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const { link } = request.body as { link?: string };
    const result = await guardarReviewLink(tenantId, { link: link ?? "" });
    const redirectUrl = result.ok
      ? `/admin/${tenantId}/configuracion?guardado=1`
      : `/admin/${tenantId}/configuracion?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/:tenantId/configuracion/cobros", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const { privateKey, eventsSecret } = request.body as {
      privateKey?: string;
      eventsSecret?: string;
    };
    const result = await guardarCobros(tenantId, {
      privateKey: privateKey ?? "",
      eventsSecret: eventsSecret ?? "",
    });
    const redirectUrl = result.ok
      ? `/admin/${tenantId}/configuracion?guardado=1`
      : `/admin/${tenantId}/configuracion?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.get("/admin/:tenantId/productos", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const html = await renderProductosPage(tenantId, request.admin?.role === "master");
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/:tenantId/pedidos", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const html = await renderPedidosPage(tenantId, request.admin?.role === "master");
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

  // Público (sin Basic Auth, igual que /webhooks/whatsapp): Wompi no puede
  // autenticarse contra el panel — la autenticidad la da el checksum de la
  // firma (ver wompiWebhookHandler.ts), no esta capa de transporte.
  app.post("/webhooks/wompi", async (request, reply) => {
    const result = await handleWompiWebhook(request.body);
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

  app.get("/resena/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const result = await renderReviewForm(token);
    if (!result.html) {
      return reply.status(result.status).send();
    }
    return reply.status(result.status).type("text/html").send(result.html);
  });

  app.post("/resena/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const { review_text: reviewText } = request.body as { review_text?: string };
    const result = await submitReview(token, reviewText ?? "");
    if (!result.html) {
      return reply.status(result.status).send();
    }
    return reply.status(result.status).type("text/html").send(result.html);
  });

  app.get("/resena/:token/compartir", async (request, reply) => {
    const { token } = request.params as { token: string };
    const result = await shareReviewPublicly(token);
    if (!result.redirectUrl) {
      return reply.status(result.status).send();
    }
    return reply.status(result.status).redirect(result.redirectUrl);
  });

  return app;
}
