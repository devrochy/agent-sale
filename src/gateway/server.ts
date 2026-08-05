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
  activarAliado,
  activarBotLead,
  activarCategoria,
  activarColaborador,
  activarPromocion,
  confirmarImportacionCsv,
  crearAliado,
  crearCategoria,
  crearColaborador,
  crearPromocion,
  crearProducto,
  desactivarAliado,
  desactivarBotLead,
  desactivarCategoria,
  desactivarColaborador,
  desactivarPromocion,
  exportLeadsCsv,
  guardarAliado,
  guardarCategoria,
  guardarCobros,
  guardarComportamiento,
  guardarInfoLead,
  guardarModeloIa,
  guardarPerfil,
  guardarPermisosColaborador,
  guardarPromocion,
  guardarProducto,
  guardarReporteDiario,
  guardarReviewLink,
  pausarBot,
  previsualizarImportacionCsv,
  reactivarBot,
  renderAliadosPage,
  renderAnaliticaPage,
  renderCategoriasPage,
  renderColaboradoresPage,
  renderConexionesPage,
  renderConfiguracionPage,
  renderConversacionesPage,
  renderFlujoPage,
  renderLeadsPage,
  renderLoginPage,
  renderOverviewPage,
  renderPedidosPage,
  renderPerfilPage,
  renderProductosPage,
  renderPromocionesPage,
  renderTicketsPage,
} from "../admin/adminPanel.js";
import { isUsernameTaken, type AdminRecord } from "../admin/auth/adminsDirectory.js";
import { currentAdmin, SESSION_COOKIE_NAME } from "../admin/auth/currentAdmin.js";
import { login, logout } from "../admin/auth/session.js";
import { registrarGuia } from "../domains/commerce/registrarGuia.js";
import { renderReviewForm, shareReviewPublicly, submitReview } from "../reviews/reviewView.js";
import { logger } from "../shared/observability/logger.js";
import { handleInboundWebhook } from "./webhookHandler.js";
import { handleWompiWebhook } from "./wompiWebhookHandler.js";

declare module "fastify" {
  interface FastifyRequest {
    // Seteado por el hook de auth de /admin/* (ver más abajo) — null en
    // cualquier ruta pública (webhooks, /asesor, /resena, /login).
    admin: AdminRecord | null;
  }
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
  // configuración del lado de Twilio. El registro se espera
  // explícitamente: sin el `await`, el hook global de rate limiting no
  // queda activo a tiempo para las rutas que se declaran a continuación.
  await app.register(rateLimit, { max: 200, timeWindow: "1 minute" });

  app.get("/healthz", async () => ({ status: "ok" }));

  // Cookies sin firmar (ver src/admin/auth/currentAdmin.ts) — el token de
  // sesión ya es el secreto, validado contra `admin_sessions` en Postgres.
  await app.register(fastifyCookie);
  app.decorateRequest("admin", null);

  // Panel admin (Fase 13, ver src/admin/auth/session.ts y ADR-025):
  // Basic Auth global quedó retirado. Todo `/admin/*` requiere sesión
  // válida. El login/logout combinado (Fase 13 v2, ver ADR-032) vive en
  // `/login`/`/logout`, fuera de este prefijo, así que no necesita ningún
  // caso especial acá — queda público por no matchear el prefijo.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/admin")) {
      return;
    }

    const admin = await currentAdmin(request);
    if (!admin) {
      return reply.status(303).redirect("/login");
    }
    request.admin = admin;
  });

  // Colaboradores (Fase 13, ver ADR-025) — el hook de arriba solo exige
  // sesión válida, no `role='master'`; esa restricción es específica de
  // esta sección, así que se chequea acá, no en el hook global.
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.match(/^\/admin\/colaboradores/i)) {
      return;
    }
    if (request.admin?.role !== "master") {
      return reply.status(403).send("Solo un administrador master puede gestionar colaboradores.");
    }
  });

  app.get("/login", async (request, reply) => {
    const html = await renderLoginPage();
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.post("/login", async (request, reply) => {
    const { identifier, password } = request.body as { identifier?: string; password?: string };
    const token = identifier && password ? await login(identifier, password) : null;

    if (!token) {
      const html = await renderLoginPage("Correo o contraseña incorrectos.");
      if (!html) {
        return reply.status(404).send();
      }
      return reply.status(401).type("text/html").send(html);
    }

    reply.setCookie(SESSION_COOKIE_NAME, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: request.protocol === "https",
      maxAge: 7 * 24 * 60 * 60,
    });
    return reply.status(303).redirect("/admin");
  });

  app.post("/logout", async (request, reply) => {
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    if (token) {
      await logout(token);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return reply.status(303).redirect("/login");
  });

  app.get("/admin", async (request, reply) => {
    const html = await renderOverviewPage(request.admin!);
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/conversaciones", async (request, reply) => {
    const { estado, c } = request.query as { estado?: string; c?: string };
    const html = await renderConversacionesPage(estado, c, request.admin!);
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/leads", async (request, reply) => {
    const { guardado } = request.query as { guardado?: string };
    const html = await renderLeadsPage(request.admin!, { guardado });
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/leads.csv", async (_request, reply) => {
    const csv = await exportLeadsCsv();
    if (csv === null) {
      return reply.status(404).send();
    }
    return reply
      .type("text/csv")
      .header("content-disposition", 'attachment; filename="leads.csv"')
      .send(csv);
  });

  app.post("/admin/leads/:customerId", async (request, reply) => {
    const { customerId } = request.params as { customerId: string };
    const { fullName, idDocument, address, municipality, city } = request.body as {
      fullName?: string;
      idDocument?: string;
      address?: string;
      municipality?: string;
      city?: string;
    };
    await guardarInfoLead(customerId, { fullName: fullName ?? null, idDocument: idDocument ?? null, address: address ?? null, municipality: municipality ?? null, city: city ?? null });
    return reply.status(303).redirect("/admin/leads?guardado=1");
  });

  app.post("/admin/leads/:customerId/activar", async (request, reply) => {
    const { customerId } = request.params as { customerId: string };
    await activarBotLead(customerId);
    return reply.status(303).redirect("/admin/leads?guardado=1");
  });

  app.post("/admin/leads/:customerId/desactivar", async (request, reply) => {
    const { customerId } = request.params as { customerId: string };
    await desactivarBotLead(customerId);
    return reply.status(303).redirect("/admin/leads?guardado=1");
  });

  app.get("/admin/tickets", async (request, reply) => {
    const html = await renderTicketsPage(request.admin!);
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/analitica", async (request, reply) => {
    const { moneda } = request.query as { moneda?: string };
    const html = await renderAnaliticaPage(moneda, request.admin!);
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/flujo", async (request, reply) => {
    const html = await renderFlujoPage(request.admin!);
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/conexiones", async (request, reply) => {
    const html = await renderConexionesPage(request.admin!);
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/colaboradores", async (request, reply) => {
    const { error, guardado } = request.query as { error?: string; guardado?: string };
    const html = await renderColaboradoresPage(request.admin!, { error, guardado });
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.post("/admin/colaboradores", async (request, reply) => {
    const { username, email, password, role, phonePrefix, phoneNumber } = request.body as {
      username?: string;
      email?: string;
      password?: string;
      role?: string;
      phonePrefix?: string;
      phoneNumber?: string;
    };
    const result = await crearColaborador({
      username: username ?? "",
      email: email ?? "",
      password: password ?? "",
      role: role ?? "",
      phonePrefix: phonePrefix ?? "",
      phoneNumber: phoneNumber ?? "",
    });
    const redirectUrl = result.ok
      ? "/admin/colaboradores?guardado=1"
      : `/admin/colaboradores?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/colaboradores/:adminId/activar", async (request, reply) => {
    const { adminId } = request.params as { adminId: string };
    await activarColaborador(adminId);
    return reply.status(303).redirect("/admin/colaboradores?guardado=1");
  });

  app.post("/admin/colaboradores/:adminId/desactivar", async (request, reply) => {
    const { adminId } = request.params as { adminId: string };
    await desactivarColaborador(adminId);
    return reply.status(303).redirect("/admin/colaboradores?guardado=1");
  });

  app.post("/admin/colaboradores/:adminId/permisos", async (request, reply) => {
    const { adminId } = request.params as { adminId: string };
    const body = request.body as Record<string, string | undefined>;
    await guardarPermisosColaborador(adminId, {
      recibeReporteDiario: body.recibeReporteDiario === "on",
      recibeTickets: body.recibeTickets === "on",
      recibeNotificacionPagos: body.recibeNotificacionPagos === "on",
    });
    return reply.status(303).redirect("/admin/colaboradores?guardado=1");
  });

  // Perfil (Fase 13 v2, ver ADR-032): cualquier admin autenticado, master o
  // colaborador — a propósito por fuera del preHandler de arriba, que solo
  // gatea `/admin/colaboradores`.
  app.get("/admin/perfil", async (request, reply) => {
    const { error, guardado } = request.query as { error?: string; guardado?: string };
    const html = await renderPerfilPage(request.admin!, { error, guardado });
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.post("/admin/perfil", async (request, reply) => {
    const { username, email, phonePrefix, phoneNumber, avatarData } = request.body as {
      username?: string;
      email?: string;
      phonePrefix?: string;
      phoneNumber?: string;
      avatarData?: string;
    };
    const result = await guardarPerfil(request.admin!, {
      username: username ?? "",
      email: email ?? "",
      phonePrefix: phonePrefix ?? "",
      phoneNumber: phoneNumber ?? "",
      avatarData: avatarData ?? "",
    });
    const redirectUrl = result.ok
      ? "/admin/perfil?guardado=1"
      : `/admin/perfil?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  // Chequeo de disponibilidad en vivo (Fase 13 v2): cualquier admin
  // autenticado, no solo master — lo usa tanto el alta de un colaborador
  // como la edición del propio Perfil, a propósito por fuera del prefijo
  // `/admin/colaboradores` que el preHandler de arriba gatea a master.
  app.get("/admin/username-disponible", async (request, reply) => {
    const { username, excludeSelf } = request.query as { username?: string; excludeSelf?: string };
    if (!username) {
      return reply.send({ taken: false });
    }
    // `excludeSelf=1` solo lo manda el form de Perfil (ver CLIENT_SCRIPT) —
    // ahí sí hay que excluir al propio admin logueado, porque está
    // reafirmando su username actual, no reservando uno nuevo. Desde el
    // alta de un colaborador (Colaboradores) no se manda: no hay que
    // excluir a nadie.
    const taken = await isUsernameTaken(
      username.trim().toLowerCase(),
      excludeSelf === "1" ? request.admin!.id : null,
    );
    return reply.send({ taken });
  });

  app.get("/admin/configuracion", async (request, reply) => {
    const { error, guardado } = request.query as { error?: string; guardado?: string };
    const html = await renderConfiguracionPage({ error, guardado }, request.admin!);
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.post("/admin/configuracion/pausar", async (_request, reply) => {
    await pausarBot();
    return reply.status(303).redirect("/admin/configuracion");
  });

  app.post("/admin/configuracion/reactivar", async (_request, reply) => {
    await reactivarBot();
    return reply.status(303).redirect("/admin/configuracion");
  });

  app.post("/admin/configuracion/modelo-ia", async (request, reply) => {
    const { provider, model, apiKey, routingMode } = request.body as {
      provider?: string;
      model?: string;
      apiKey?: string;
      routingMode?: string;
    };
    const result = await guardarModeloIa({
      provider: provider ?? "",
      model: model ?? "",
      apiKey: apiKey ?? "",
      routingMode: routingMode ?? "",
    });
    const redirectUrl = result.ok
      ? "/admin/configuracion?guardado=1"
      : `/admin/configuracion?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/configuracion/comportamiento", async (request, reply) => {
    const { tono, estiloMensajes, velocidadRespuesta } = request.body as {
      tono?: string;
      estiloMensajes?: string;
      velocidadRespuesta?: string;
    };
    const result = await guardarComportamiento({
      tono: tono ?? "",
      estiloMensajes: estiloMensajes ?? "",
      velocidadRespuesta: velocidadRespuesta ?? "",
    });
    const redirectUrl = result.ok
      ? "/admin/configuracion?guardado=1"
      : `/admin/configuracion?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/configuracion/reporte-diario", async (request, reply) => {
    const { telefono, frecuencia, diasPersonalizados } = request.body as {
      telefono?: string;
      frecuencia?: string;
      diasPersonalizados?: string;
    };
    const result = await guardarReporteDiario({
      telefono: telefono ?? "",
      frecuencia: frecuencia ?? "",
      diasPersonalizados: diasPersonalizados ?? "",
    });
    const redirectUrl = result.ok
      ? "/admin/configuracion?guardado=1"
      : `/admin/configuracion?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/configuracion/resenas", async (request, reply) => {
    const { link } = request.body as { link?: string };
    const result = await guardarReviewLink({ link: link ?? "" });
    const redirectUrl = result.ok
      ? "/admin/configuracion?guardado=1"
      : `/admin/configuracion?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/configuracion/cobros", async (request, reply) => {
    const { privateKey, eventsSecret } = request.body as {
      privateKey?: string;
      eventsSecret?: string;
    };
    const result = await guardarCobros({
      privateKey: privateKey ?? "",
      eventsSecret: eventsSecret ?? "",
    });
    const redirectUrl = result.ok
      ? "/admin/configuracion?guardado=1"
      : `/admin/configuracion?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.get("/admin/productos", async (request, reply) => {
    const { error, guardado, allyId, categoryId, creados, actualizados, errores } = request.query as {
      error?: string;
      guardado?: string;
      allyId?: string;
      categoryId?: string;
      creados?: string;
      actualizados?: string;
      errores?: string;
    };
    const html = await renderProductosPage(request.admin!, {
      error,
      guardado,
      allyId,
      categoryId,
      creados,
      actualizados,
      errores,
    });
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.get("/admin/pedidos", async (request, reply) => {
    const { error, guardado } = request.query as { error?: string; guardado?: string };
    const html = await renderPedidosPage(request.admin!, { error, guardado });
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.post("/admin/pedidos/:orderId/guia", async (request, reply) => {
    const { orderId } = request.params as { orderId: string };
    const { trackingNumber, carrier } = request.body as { trackingNumber?: string; carrier?: string };
    const result = await registrarGuia(orderId, {
      trackingNumber: trackingNumber ?? "",
      carrier: carrier ?? "",
    });
    const redirectUrl = result.ok
      ? "/admin/pedidos?guardado=1"
      : `/admin/pedidos?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/productos", async (request, reply) => {
    const body = request.body as Record<string, string | string[] | undefined>;
    const result = await crearProducto({
      name: (body.name as string) ?? "",
      description: (body.description as string) ?? "",
      imageUrl: (body.imageUrl as string) ?? "",
      allyId: (body.allyId as string) ?? "",
      categoryId: (body.categoryId as string) ?? "",
      variants: body,
    });
    const redirectUrl = result.ok
      ? "/admin/productos?guardado=1"
      : `/admin/productos?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/productos/:productId", async (request, reply) => {
    const { productId } = request.params as { productId: string };
    const body = request.body as Record<string, string | string[] | undefined>;
    const result = await guardarProducto(productId, {
      name: (body.name as string) ?? "",
      description: (body.description as string) ?? "",
      imageUrl: (body.imageUrl as string) ?? "",
      allyId: (body.allyId as string) ?? "",
      categoryId: (body.categoryId as string) ?? "",
      variants: body,
    });
    const redirectUrl = result.ok
      ? "/admin/productos?guardado=1"
      : `/admin/productos?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/productos/importar/previsualizar", async (request, reply) => {
    const { csvText } = request.body as { csvText?: string };
    if (!csvText) {
      return reply.send({ ok: false, error: "Elegí un archivo CSV primero." });
    }
    const resultado = await previsualizarImportacionCsv(csvText);
    return reply.send(resultado);
  });

  app.post("/admin/productos/importar", async (request, reply) => {
    const body = request.body as Record<string, string | string[] | undefined>;
    const allyId = body.allyId as string | undefined;
    if (!allyId) {
      return reply
        .status(303)
        .redirect(`/admin/productos?error=${encodeURIComponent("Elegí un aliado antes de confirmar la carga.")}`);
    }
    const toArray = (value: string | string[] | undefined): string[] =>
      value === undefined ? [] : Array.isArray(value) ? value : [value];
    const skus = toArray(body["sku[]"]);
    const names = toArray(body["name[]"]);
    const prices = toArray(body["price[]"]);
    const stocks = toArray(body["stock[]"]);
    const tallas = toArray(body["talla[]"]);
    const colors = toArray(body["color[]"]);
    const categoryIds = toArray(body["categoryId[]"]);
    const descriptions = toArray(body["description[]"]);
    const imageUrls = toArray(body["imageUrl[]"]);
    const rows = skus.map((sku, i) => ({
      sku,
      name: names[i] ?? "",
      price: prices[i] ?? "",
      stock: stocks[i] ?? "",
      talla: tallas[i] ?? "",
      color: colors[i] ?? "",
      categoryId: categoryIds[i] ?? "",
      description: descriptions[i] ?? "",
      imageUrl: imageUrls[i] ?? "",
    }));

    const resultado = await confirmarImportacionCsv(allyId, rows);
    return reply
      .status(303)
      .redirect(
        `/admin/productos?creados=${resultado.creados}&actualizados=${resultado.actualizados}&errores=${resultado.errores.length}`,
      );
  });

  app.get("/admin/aliados", async (request, reply) => {
    const { error, guardado } = request.query as { error?: string; guardado?: string };
    const html = await renderAliadosPage(request.admin!, { error, guardado });
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.post("/admin/aliados", async (request, reply) => {
    const { name, contactInfo } = request.body as { name?: string; contactInfo?: string };
    const result = await crearAliado({ name: name ?? "", contactInfo: contactInfo ?? "" });
    const redirectUrl = result.ok
      ? "/admin/aliados?guardado=1"
      : `/admin/aliados?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/aliados/:allyId", async (request, reply) => {
    const { allyId } = request.params as { allyId: string };
    const { name, contactInfo } = request.body as { name?: string; contactInfo?: string };
    const result = await guardarAliado(allyId, { name: name ?? "", contactInfo: contactInfo ?? "" });
    const redirectUrl = result.ok
      ? "/admin/aliados?guardado=1"
      : `/admin/aliados?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/aliados/:allyId/activar", async (request, reply) => {
    const { allyId } = request.params as { allyId: string };
    await activarAliado(allyId);
    return reply.status(303).redirect("/admin/aliados?guardado=1");
  });

  app.post("/admin/aliados/:allyId/desactivar", async (request, reply) => {
    const { allyId } = request.params as { allyId: string };
    await desactivarAliado(allyId);
    return reply.status(303).redirect("/admin/aliados?guardado=1");
  });

  app.get("/admin/categorias", async (request, reply) => {
    const { error, guardado } = request.query as { error?: string; guardado?: string };
    const html = await renderCategoriasPage(request.admin!, { error, guardado });
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.post("/admin/categorias", async (request, reply) => {
    const { name, parentId, sortOrder } = request.body as {
      name?: string;
      parentId?: string;
      sortOrder?: string;
    };
    const result = await crearCategoria({
      name: name ?? "",
      parentId: parentId ?? "",
      sortOrder: sortOrder ?? "0",
    });
    const redirectUrl = result.ok
      ? "/admin/categorias?guardado=1"
      : `/admin/categorias?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/categorias/:categoryId", async (request, reply) => {
    const { categoryId } = request.params as { categoryId: string };
    const { name, parentId, sortOrder, complementIds } = request.body as {
      name?: string;
      parentId?: string;
      sortOrder?: string;
      complementIds?: string | string[];
    };
    const complementIdsList = complementIds === undefined ? [] : ([] as string[]).concat(complementIds);
    const result = await guardarCategoria(categoryId, {
      name: name ?? "",
      parentId: parentId ?? "",
      sortOrder: sortOrder ?? "0",
      complementIds: complementIdsList,
    });
    const redirectUrl = result.ok
      ? "/admin/categorias?guardado=1"
      : `/admin/categorias?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/categorias/:categoryId/activar", async (request, reply) => {
    const { categoryId } = request.params as { categoryId: string };
    await activarCategoria(categoryId);
    return reply.status(303).redirect("/admin/categorias?guardado=1");
  });

  app.post("/admin/categorias/:categoryId/desactivar", async (request, reply) => {
    const { categoryId } = request.params as { categoryId: string };
    await desactivarCategoria(categoryId);
    return reply.status(303).redirect("/admin/categorias?guardado=1");
  });

  app.get("/admin/promociones", async (request, reply) => {
    const { error, guardado } = request.query as { error?: string; guardado?: string };
    const html = await renderPromocionesPage(request.admin!, { error, guardado });
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.post("/admin/promociones", async (request, reply) => {
    const result = await crearPromocion(request.body as Parameters<typeof crearPromocion>[0]);
    const redirectUrl = result.ok
      ? "/admin/promociones?guardado=1"
      : `/admin/promociones?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/promociones/:promotionId", async (request, reply) => {
    const { promotionId } = request.params as { promotionId: string };
    const result = await guardarPromocion(promotionId, request.body as Parameters<typeof crearPromocion>[0]);
    const redirectUrl = result.ok
      ? "/admin/promociones?guardado=1"
      : `/admin/promociones?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/promociones/:promotionId/activar", async (request, reply) => {
    const { promotionId } = request.params as { promotionId: string };
    await activarPromocion(promotionId);
    return reply.status(303).redirect("/admin/promociones?guardado=1");
  });

  app.post("/admin/promociones/:promotionId/desactivar", async (request, reply) => {
    const { promotionId } = request.params as { promotionId: string };
    await desactivarPromocion(promotionId);
    return reply.status(303).redirect("/admin/promociones?guardado=1");
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
