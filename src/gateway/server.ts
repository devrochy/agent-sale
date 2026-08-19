import { timingSafeEqual } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { renderHandoffView } from "../advisor/handoffView.js";
import {
  activarAliado,
  activarBotConversacion,
  activarBotLead,
  activarCategoria,
  activarColaborador,
  activarPromocion,
  cambiarContrasenaPropia,
  cancelarPedido,
  confirmarImportacionCsv,
  crearAliado,
  crearCategoria,
  crearColaborador,
  crearConexionMeta,
  crearPromocion,
  crearProducto,
  desactivarAliado,
  desactivarBotConversacion,
  desactivarBotLead,
  desactivarCategoria,
  desactivarColaborador,
  desactivarPromocion,
  editarColaborador,
  enviarMensajeHumano,
  exportLeadsCsv,
  guardarAliado,
  guardarCategoria,
  guardarCobros,
  guardarCuentasTransferencia,
  guardarComportamiento,
  guardarCredencialesConexion,
  guardarInfoLead,
  guardarModeloIa,
  guardarPerfil,
  guardarPermisosColaborador,
  guardarPromocion,
  guardarProducto,
  guardarReporteDiario,
  guardarReviewLink,
  guardarVozMarca,
  marcarConexionPrimary,
  marcarPedidoEntregado,
  pausarBot,
  previsualizarImportacionCsv,
  reactivarBot,
  reasignarTicketABot,
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
  renderRecuperarContrasenaPage,
  renderRestablecerContrasenaPage,
  renderTicketsPage,
  resolverTicket,
  restablecerContrasenaConToken,
  solicitarRecuperacionContrasena,
  setConexionActiva,
  tomarTicket,
} from "../admin/adminPanel.js";
import { isUsernameTaken, type AdminRecord } from "../admin/auth/adminsDirectory.js";
import { currentAdmin, SESSION_COOKIE_NAME } from "../admin/auth/currentAdmin.js";
import { login, logout } from "../admin/auth/session.js";
import { env } from "../config/env.js";
import { registrarGuia } from "../domains/commerce/registrarGuia.js";
import { renderReviewForm, shareReviewPublicly, submitReview } from "../reviews/reviewView.js";
import { listConnectionsWithCredentials, type Channel } from "../shared/db/connectionsDirectory.js";
import { logger } from "../shared/observability/logger.js";
import { handleInboundWebhook } from "./webhookHandler.js";
import { handleWompiWebhook } from "./wompiWebhookHandler.js";

declare module "fastify" {
  interface FastifyRequest {
    // Seteado por el hook de auth de /admin/* (ver más abajo) — null en
    // cualquier ruta pública (webhooks, /asesor, /resena, /login).
    admin: AdminRecord | null;
    // Bytes crudos del body, solo dentro del plugin de webhooks (ver el
    // parser encapsulado más abajo). Los adapters que firman sobre el cuerpo
    // sin parsear los necesitan; el resto de la app no los ve.
    rawBody?: Buffer;
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

  // Colaboradores (Fase 13, ver ADR-025) y Conexiones (Fase 19) — el hook de
  // arriba solo exige sesión válida, no `role='master'`; esa restricción es
  // específica de estas secciones, así que se chequea acá, no en el hook
  // global. Cubre GET y POST por igual: Conexiones maneja credenciales de
  // los canales, así que restringirla es un endurecimiento deliberado
  // respecto de la versión anterior de la página, que veía cualquier admin.
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.match(/^\/admin\/(colaboradores|conexiones)/i)) {
      return;
    }
    if (request.admin?.role !== "master") {
      return reply.status(403).send("Solo un administrador master puede gestionar esta sección.");
    }
  });

  app.get("/login", async (request, reply) => {
    // `?contrasena=cambiada` llega desde los dos caminos que reescriben la
    // contraseña: el enlace de recuperación y el cambio desde el Perfil.
    // Los dos cierran la sesión, así que el aviso tiene que salir acá y no
    // en la página desde donde se hizo el cambio.
    const { contrasena } = request.query as { contrasena?: string };
    const html = await renderLoginPage(
      undefined,
      contrasena === "cambiada" ? "Contraseña actualizada. Entrá con la nueva." : undefined,
    );
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  // Límite propio y estrecho para el login (el global de arriba, 200/min,
  // es de tráfico normal y deja espacio de sobra para fuerza bruta). Se
  // volvió necesario al publicar el panel en Internet: sin esto son ~288k
  // intentos de contraseña al día por IP. 10 por minuto no estorba a nadie
  // que sepa su contraseña y corta el barrido automatizado.
  app.post(
    "/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
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
    },
  );

  // Recuperación de contraseña (ver
  // docs/fase-11-panel-admin-dashboard/contrasena.md). Igual que
  // `/login`/`/logout`, viven fuera de `/admin` y por eso el hook de auth
  // no las toca: son justamente las rutas para quien no puede autenticarse.
  app.get("/recuperar-contrasena", async (request, reply) => {
    const html = await renderRecuperarContrasenaPage(request.query as { enviado?: string });
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  // 3 por minuto: cada pedido válido gasta un mensaje de WhatsApp al
  // teléfono de un admin. Sin este techo, el formulario público es un
  // botón para inundar de mensajes a alguien que no pidió nada.
  app.post(
    "/recuperar-contrasena",
    { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { identifier } = request.body as { identifier?: string };
      if (identifier) {
        await solicitarRecuperacionContrasena(identifier);
      }
      // Siempre el mismo destino, exista o no la cuenta — ver
      // `solicitarRecuperacionContrasena`.
      return reply.status(303).redirect("/recuperar-contrasena?enviado=1");
    },
  );

  app.get("/restablecer-contrasena", async (request, reply) => {
    const html = await renderRestablecerContrasenaPage(
      request.query as { token?: string; error?: string },
    );
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  app.post(
    "/restablecer-contrasena",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { token, password, confirmacion } = request.body as {
        token?: string;
        password?: string;
        confirmacion?: string;
      };
      if (!token || !password) {
        return reply.status(303).redirect("/recuperar-contrasena");
      }
      const result = await restablecerContrasenaConToken({
        token,
        password,
        confirmacion: confirmacion ?? "",
      });
      if (result.ok) {
        // La cookie de esta sesión —si la había— ya no vale: cambiar la
        // contraseña borra todas las sesiones del admin.
        reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
        return reply.status(303).redirect("/login?contrasena=cambiada");
      }
      // El token sigue vigente cuando el error fue de la contraseña escrita
      // (corta, o las dos no coinciden): se vuelve al mismo formulario. Si
      // el enlace ya no sirve, no hay formulario al que volver.
      return reply
        .status(303)
        .redirect(
          result.tokenVigente
            ? `/restablecer-contrasena?token=${encodeURIComponent(token)}&error=${encodeURIComponent(result.error)}`
            : "/restablecer-contrasena",
        );
    },
  );

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

  app.post("/admin/conversaciones/:handoffId/tomar", async (request, reply) => {
    const { handoffId } = request.params as { handoffId: string };
    const conversationId = await tomarTicket(handoffId, request.admin!);
    const suffix = conversationId ? `&c=${conversationId}` : "";
    return reply.status(303).redirect(`/admin/conversaciones?estado=escaladas${suffix}`);
  });

  app.post("/admin/conversaciones/:handoffId/resolver", async (request, reply) => {
    const { handoffId } = request.params as { handoffId: string };
    const conversationId = await resolverTicket(handoffId, request.admin!);
    const suffix = conversationId ? `&c=${conversationId}` : "";
    // resolverTicket cierra la conversación (conversations.status = 'closed')
    // — el filtro debe reflejar eso, no "escaladas" (que ya no aplica).
    return reply.status(303).redirect(`/admin/conversaciones?estado=cerradas${suffix}`);
  });

  app.post("/admin/conversaciones/:handoffId/reasignar-bot", async (request, reply) => {
    const { handoffId } = request.params as { handoffId: string };
    const conversationId = await reasignarTicketABot(handoffId, request.admin!);
    const suffix = conversationId ? `&c=${conversationId}` : "";
    // reasignarTicketABot deja la conversación abierta en manos del bot,
    // ya no "escalada" (handoff_queue.status pasó a 'resuelto').
    return reply.status(303).redirect(`/admin/conversaciones?estado=abiertas${suffix}`);
  });

  // Pausar/reactivar el bot no cambia ni el estado de la conversación ni
  // el filtro que el admin tenía abierto (pedido explícito del usuario) —
  // `estado` viaja en la querystring del propio botón (ver toggleSwitchHtml)
  // y solo se usa para volver adonde ya estaba, nunca para decidir algo.
  app.post("/admin/conversaciones/:conversationId/bot/activar", async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const { estado } = request.query as { estado?: string };
    await activarBotConversacion(conversationId);
    return reply
      .status(303)
      .redirect(`/admin/conversaciones?estado=${estado ?? "abiertas"}&c=${conversationId}`);
  });

  app.post("/admin/conversaciones/:conversationId/bot/desactivar", async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const { estado } = request.query as { estado?: string };
    await desactivarBotConversacion(conversationId);
    return reply
      .status(303)
      .redirect(`/admin/conversaciones?estado=${estado ?? "abiertas"}&c=${conversationId}`);
  });

  app.post("/admin/conversaciones/:conversationId/mensaje", async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const { mensaje, estado } = request.body as { mensaje?: string; estado?: string };
    await enviarMensajeHumano(conversationId, mensaje ?? "");
    return reply
      .status(303)
      .redirect(`/admin/conversaciones?estado=${estado ?? "escaladas"}&c=${conversationId}`);
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
    await guardarInfoLead(customerId, {
      fullName: fullName ?? null,
      idDocument: idDocument ?? null,
      address: address ?? null,
      municipality: municipality ?? null,
      city: city ?? null,
    });
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
    const { error, guardado } = request.query as { error?: string; guardado?: string };
    const html = await renderConexionesPage(request.admin!, { error, guardado });
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  // Antes que la ruta con :connectionId, para que "meta" no se interprete como
  // un id de conexión.
  // Canales que el adapter de Meta sabe dar de alta hoy. `messenger` sale
  // recién en la Etapa C3: aceptarlo antes crearía una conexión que valida
  // contra Meta pero que ningún webhook sabe rutear.
  const CANALES_META: Channel[] = ["whatsapp", "instagram"];

  // El canal va en la ruta (Etapa C2): una misma app de Meta sirve WhatsApp e
  // Instagram, con credenciales y validación distintas por canal.
  app.post("/admin/conexiones/meta/:channel", async (request, reply) => {
    const { channel } = request.params as { channel: string };
    if (!CANALES_META.includes(channel as Channel)) {
      return reply
        .status(303)
        .redirect(`/admin/conexiones?error=${encodeURIComponent("Canal no soportado.")}`);
    }
    const result = await crearConexionMeta(
      channel as Channel,
      request.body as Record<string, string | undefined>,
    );
    const redirectUrl = result.ok
      ? "/admin/conexiones?guardado=1"
      : `/admin/conexiones?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/conexiones/:connectionId/credenciales", async (request, reply) => {
    const { connectionId } = request.params as { connectionId: string };
    const result = await guardarCredencialesConexion(
      connectionId,
      request.body as Record<string, string | undefined>,
    );
    const redirectUrl = result.ok
      ? "/admin/conexiones?guardado=1"
      : `/admin/conexiones?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/conexiones/:connectionId/bot/activar", async (request, reply) => {
    const { connectionId } = request.params as { connectionId: string };
    await setConexionActiva(connectionId, true);
    return reply.status(303).redirect("/admin/conexiones");
  });

  app.post("/admin/conexiones/:connectionId/bot/desactivar", async (request, reply) => {
    const { connectionId } = request.params as { connectionId: string };
    await setConexionActiva(connectionId, false);
    return reply.status(303).redirect("/admin/conexiones");
  });

  app.post("/admin/conexiones/:connectionId/primary", async (request, reply) => {
    const { connectionId } = request.params as { connectionId: string };
    await marcarConexionPrimary(connectionId);
    return reply.status(303).redirect("/admin/conexiones");
  });

  app.get("/admin/colaboradores", async (request, reply) => {
    const { error, guardado } = request.query as { error?: string; guardado?: string };
    const html = await renderColaboradoresPage(request.admin!, { error, guardado });
    if (!html) {
      return reply.status(404).send();
    }
    return reply.type("text/html").send(html);
  });

  // Transiciones manuales de un pedido. Van bajo /admin (sesión exigida por
  // el hook) pero no bajo el gate de master: despachar y cerrar pedidos es
  // trabajo de cualquier colaborador con acceso al panel.
  app.post("/admin/configuracion/transferencias", async (request, reply) => {
    const result = await guardarCuentasTransferencia(
      request.body as Record<string, string | string[]>,
    );
    const redirectUrl = result.ok
      ? "/admin/configuracion?guardado=1#cobros"
      : `/admin/configuracion?error=${encodeURIComponent(result.error)}#cobros`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/pedidos/:orderId/entregado", async (request, reply) => {
    const { orderId } = request.params as { orderId: string };
    await marcarPedidoEntregado(orderId);
    return reply.status(303).redirect("/admin/pedidos?guardado=1");
  });

  app.post("/admin/pedidos/:orderId/cancelar", async (request, reply) => {
    const { orderId } = request.params as { orderId: string };
    await cancelarPedido(orderId, request.admin!);
    return reply.status(303).redirect("/admin/pedidos?guardado=1");
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

  // Editar los datos de OTRA cuenta. El preHandler de arriba ya exigió
  // master; `editarColaborador` se encarga de la única regla que depende de
  // quién edita a quién (un master no se baja el rol a sí mismo).
  app.post("/admin/colaboradores/:adminId", async (request, reply) => {
    const { adminId } = request.params as { adminId: string };
    const { username, email, role, phonePrefix, phoneNumber } = request.body as {
      username?: string;
      email?: string;
      role?: string;
      phonePrefix?: string;
      phoneNumber?: string;
    };
    const result = await editarColaborador(request.admin!, adminId, {
      username: username ?? "",
      email: email ?? "",
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
    const { error, guardado, errorContrasena } = request.query as {
      error?: string;
      guardado?: string;
      errorContrasena?: string;
    };
    const html = await renderPerfilPage(request.admin!, { error, guardado, errorContrasena });
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

  // Cambio de contraseña con sesión iniciada. Va bajo `/admin`, así que el
  // hook de auth ya garantizó la sesión; la contraseña actual se pide igual
  // dentro de `cambiarContrasenaPropia` (ver por qué, allá).
  app.post(
    "/admin/perfil/contrasena",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { actual, password, confirmacion } = request.body as {
        actual?: string;
        password?: string;
        confirmacion?: string;
      };
      const result = await cambiarContrasenaPropia(request.admin!, {
        actual: actual ?? "",
        password: password ?? "",
        confirmacion: confirmacion ?? "",
      });
      if (!result.ok) {
        return reply
          .status(303)
          .redirect(`/admin/perfil?errorContrasena=${encodeURIComponent(result.error)}`);
      }
      // La sesión propia acaba de morir junto con las demás — sin limpiar la
      // cookie, el redirect a /login rebotaría contra una cookie que ya no
      // resuelve y el usuario vería el login sin entender por qué.
      reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      return reply.status(303).redirect("/login?contrasena=cambiada");
    },
  );

  // Chequeo de disponibilidad en vivo (Fase 13 v2): cualquier admin
  // autenticado, no solo master — lo usa tanto el alta de un colaborador
  // como la edición del propio Perfil, a propósito por fuera del prefijo
  // `/admin/colaboradores` que el preHandler de arriba gatea a master.
  app.get("/admin/username-disponible", async (request, reply) => {
    const { username, excludeSelf, excludeAdminId } = request.query as {
      username?: string;
      excludeSelf?: string;
      excludeAdminId?: string;
    };
    if (!username) {
      return reply.send({ taken: false });
    }
    // Tres casos, y cada uno excluye a alguien distinto:
    //
    // - Alta de un colaborador: no se excluye a nadie, el usuario tiene que
    //   estar libre contra toda la tabla.
    // - Perfil propio (`excludeSelf=1`): se excluye al admin logueado, que
    //   está reafirmando su usuario actual y no reservando uno nuevo.
    // - Edición de otra cuenta desde Colaboradores (`excludeAdminId`): se
    //   excluye a la cuenta editada, por la misma razón. Solo se honra para
    //   un master, que es el único que puede abrir esa pantalla — si no,
    //   cualquier admin podría pedir la respuesta "excluyendo" a un tercero.
    //   El peor caso igual sería un booleano, pero no hay motivo para
    //   dejarlo abierto.
    const excludeId =
      excludeAdminId && request.admin!.role === "master"
        ? excludeAdminId
        : excludeSelf === "1"
          ? request.admin!.id
          : null;
    const taken = await isUsernameTaken(username.trim().toLowerCase(), excludeId);
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

  app.post("/admin/configuracion/voz-marca", async (request, reply) => {
    const { nombreAsistente, mision, vision, valores, nomenclatura } = request.body as {
      nombreAsistente?: string;
      mision?: string;
      vision?: string;
      valores?: string;
      nomenclatura?: string;
    };
    const result = await guardarVozMarca({
      nombreAsistente: nombreAsistente ?? "",
      mision: mision ?? "",
      vision: vision ?? "",
      valores: valores ?? "",
      nomenclatura: nomenclatura ?? "",
    });
    const redirectUrl = result.ok
      ? "/admin/configuracion?guardado=1"
      : `/admin/configuracion?error=${encodeURIComponent(result.error)}`;
    return reply.status(303).redirect(redirectUrl);
  });

  app.post("/admin/configuracion/reporte-diario", async (request, reply) => {
    const { telefono, prefijo, frecuencia, diasPersonalizados } = request.body as {
      telefono?: string;
      prefijo?: string;
      frecuencia?: string;
      diasPersonalizados?: string;
    };
    const result = await guardarReporteDiario({
      telefono: telefono ?? "",
      prefijo: prefijo ?? "",
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
    const { error, guardado, allyId, categoryId, creados, actualizados, errores } =
      request.query as {
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
    const { trackingNumber, carrier } = request.body as {
      trackingNumber?: string;
      carrier?: string;
    };
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
        .redirect(
          `/admin/productos?error=${encodeURIComponent("Elegí un aliado antes de confirmar la carga.")}`,
        );
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
    const result = await guardarAliado(allyId, {
      name: name ?? "",
      contactInfo: contactInfo ?? "",
    });
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
    const complementIdsList =
      complementIds === undefined ? [] : ([] as string[]).concat(complementIds);
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
    const result = await guardarPromocion(
      promotionId,
      request.body as Parameters<typeof crearPromocion>[0],
    );
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

  /**
   * Comparación de tokens en tiempo constante. `timingSafeEqual` exige buffers
   * del mismo largo, y la diferencia de largo por sí sola no es secreto acá:
   * el verify token lo elige quien configura la conexión.
   */
  function tokensIguales(esperado: string | undefined, recibido: string): boolean {
    if (!esperado) {
      return false;
    }
    const a = Buffer.from(esperado, "utf8");
    const b = Buffer.from(recibido, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // Webhooks entrantes, en un plugin encapsulado. El encapsulamiento no es
  // decorativo: los adapters de Meta (Etapa B) necesitan los **bytes crudos**
  // del body para su HMAC-SHA256, y Fastify los descarta al parsear. Declarar
  // ese parser a nivel global reemplazaría el de JSON de toda la app
  // (incluido el panel); dentro de un plugin solo aplica a estas rutas.
  await app.register(async (webhooks) => {
    // Los parsers se heredan del scope padre (el de JSON viene de Fastify, el
    // de urlencoded de @fastify/formbody), así que hay que retirarlos antes
    // de poner el propio. Ambas operaciones quedan confinadas a este plugin:
    // fuera de acá el panel sigue usando los de siempre.
    webhooks.removeContentTypeParser(["application/json", "application/x-www-form-urlencoded"]);
    webhooks.addContentTypeParser(
      ["application/json", "application/x-www-form-urlencoded"],
      { parseAs: "buffer" },
      (request, body: Buffer, done) => {
        // Se conserva el cuerpo crudo *y* se entrega el body parseado igual
        // que antes, para que ningún handler existente cambie de contrato.
        request.rawBody = body;
        const texto = body.toString("utf8");
        try {
          if (request.headers["content-type"]?.includes("application/json")) {
            done(null, texto.length === 0 ? {} : JSON.parse(texto));
            return;
          }
          done(null, Object.fromEntries(new URLSearchParams(texto)));
        } catch (error) {
          done(error as Error);
        }
      },
    );

    webhooks.post(
      "/webhooks/whatsapp",
      { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const result = await handleInboundWebhook("twilio", {
          rawBody: request.rawBody ?? Buffer.alloc(0),
          params: (request.body ?? {}) as Record<string, string>,
          headers: request.headers,
          // La URL pública fija, no reconstruida de headers: es exactamente
          // la que entra en el HMAC de Twilio (ver env.publicWebhookUrl).
          url: env.publicWebhookUrl,
        });
        return reply.status(result.status).send();
      },
    );

    /**
     * Handshake de verificación de Meta (Fase 19, Etapa B). Meta pega acá con
     * `GET` al registrar el webhook y espera que le devolvamos el
     * `hub.challenge` tal cual, en texto plano.
     *
     * El handshake no dice a qué conexión corresponde, así que el token se
     * compara contra el `verifyToken` de cualquier conexión de Meta
     * configurada — son pocas, y el token es precisamente lo que prueba que
     * quien pregunta es quien configuró alguna de ellas.
     */
    webhooks.get(
      "/webhooks/meta",
      // Mismo límite que el POST: es un endpoint sin autenticar cuyo único
      // secreto es el verify token, así que no conviene dejarlo con el global.
      { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        const token = query["hub.verify_token"];
        const challenge = query["hub.challenge"];

        const conexiones = await listConnectionsWithCredentials("meta");
        // Comparación de tiempo constante, igual que la firma del POST: con
        // `===` el tiempo de fallo filtra cuánto del token acertó quien prueba,
        // y a este endpoint se llega sin credenciales.
        const coincide =
          token !== undefined && query["hub.mode"] === "subscribe"
            ? conexiones.some((c) => tokensIguales(c.credentials.verifyToken, token))
            : false;

        if (!coincide || !challenge) {
          logger.warn({ event: "gateway.handshake_meta_rechazado" }, "Handshake de Meta rechazado");
          return reply.status(403).send();
        }
        logger.info({ event: "gateway.handshake_meta_ok" }, "Handshake de Meta verificado");
        return reply.type("text/plain").send(challenge);
      },
    );

    webhooks.post(
      "/webhooks/meta",
      { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const result = await handleInboundWebhook("meta", {
          rawBody: request.rawBody ?? Buffer.alloc(0),
          params: {},
          headers: request.headers,
          // Meta firma sobre el cuerpo crudo, no sobre la URL — este campo no
          // participa de su verificación, pero el contrato lo pide.
          url: `${new URL(env.publicWebhookUrl).origin}/webhooks/meta`,
        });
        return reply.status(result.status).send();
      },
    );

    // Público (sin Basic Auth, igual que /webhooks/whatsapp): Wompi no puede
    // autenticarse contra el panel — la autenticidad la da el checksum de la
    // firma (ver wompiWebhookHandler.ts), no esta capa de transporte.
    webhooks.post("/webhooks/wompi", async (request, reply) => {
      const result = await handleWompiWebhook(request.body);
      return reply.status(result.status).send();
    });
  });

  app.get("/asesor/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const result = await renderHandoffView(token);
    if (!result.html) {
      return reply.status(result.status).send();
    }
    return reply.status(result.status).type("text/html").send(result.html);
  });

  // ADR-028 (Fase 18, Opción 3): tomar/resolver ya no vive en el enlace de
  // token — la vista pasó a ser de solo lectura. Las rutas se conservan
  // registradas (no se retiran) para no romper enlaces de WhatsApp ya
  // enviados, pero cualquier intento de acción redirige al login del panel
  // en vez de devolver un error crudo.
  app.post("/asesor/:token/tomar", async (_request, reply) => {
    return reply.status(303).redirect("/login");
  });

  app.post("/asesor/:token/resolver", async (_request, reply) => {
    return reply.status(303).redirect("/login");
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
