# Fase 11 — Panel de Administración y Analítica

Estado: **11.1, 11.2 y 11.3 implementadas y mergeadas a `develop`** (Resumen/KPIs, Conversaciones/Leads/Tickets, Flujo/Conexiones) — 11.4 y 11.5 en diseño, pendientes de implementación.

Referencia: [MASTER_PLAN.md](../../MASTER_PLAN.md#fase-11--panel-de-administración-y-analítica) · [Fase 9 — Piloto Controlado](../fase-9-piloto-controlado/README.md) · [Fase 8 — Observabilidad, Seguridad y Guardrails](../fase-8-observabilidad-seguridad/README.md)

El panel admin actual (`src/admin/adminPanel.ts`) es deliberadamente mínimo — tenants, catálogo y pedidos, HTML de solo lectura sin interactividad (ver el comentario de `adminPanel.ts:1-9`: "no es un dashboard de cliente final"). Esta fase lo evoluciona a una herramienta operativa real para gestionar el asistente de ventas, tomando como referencia de UX un panel externo ("Forja"/"HorizontesAgentOS") ya analizado sección por sección — sin copiar su modelo de negocio PRO/FREE, solo las ideas de funcionalidad que aplican a lo que agent-sale ya tiene construido.

Esta fase **no depende de la Fase 10** (Preparación para Escala y Lanzamiento Multi-tenant) — son preocupaciones distintas: la Fase 10 es infraestructura para soportar más volumen y más tenants simultáneos, esta fase es una herramienta operativa para gestionar el/los tenant(s) que ya existen. Pueden ejecutarse en paralelo, o esta fase incluso antes, si el equipo lo decide.

## Contenido de esta fase

- [mapeo-funcionalidades.md](./mapeo-funcionalidades.md) — cada sección del panel de referencia evaluada contra el código real de agent-sale: qué es reutilizable, qué falta construir, valor/esfuerzo, y qué queda explícitamente excluido (y por qué).
- [adrs/ADR-014-arquitectura-frontend-panel.md](./adrs/ADR-014-arquitectura-frontend-panel.md) — HTML server-rendered + htmx/Alpine.js vía CDN, no React/SPA ni API JSON nueva.
- [adrs/ADR-015-alcance-autenticacion-panel.md](./adrs/ADR-015-alcance-autenticacion-panel.md) — se mantiene Basic Auth global; login por tenant se difiere a la Fase 10 real.
- [adrs/ADR-016-parametrizacion-marca-tenant.md](./adrs/ADR-016-parametrizacion-marca-tenant.md) — columna `tenants.display_name`, para que el nombre de marca del panel sea un parámetro por tenant (ForMotos sigue siendo el valor piloto) y el panel pueda escalar a clientes nuevos sin tocar código.
- [adrs/ADR-017-persistencia-uso-llm-postgres.md](./adrs/ADR-017-persistencia-uso-llm-postgres.md) — tokens/costo/latencia del LLM se persisten en Postgres (`llm_usage`), no se embebe Grafana ni se consulta Loki en vivo desde el panel.
- [overview-kpis.md](./overview-kpis.md) — **11.1**: nuevo home por tenant, KPI cards, actividad 7 días, marca configurable. Primero porque cambia el `layout()` compartido por todo el panel.
- [conversaciones-leads-tickets.md](./conversaciones-leads-tickets.md) — **11.2**: inbox de conversaciones, tabla de leads (con resumen/estado derivados, no LLM), listado agregado de tickets sobre `handoff_queue`.
- [flujo-conexiones.md](./flujo-conexiones.md) — **11.3**: diagrama estático del pipeline real del agente (con las 6 tools reales, no las del panel de referencia), tarjeta de conexión de WhatsApp/Twilio (el único canal real hoy).
- [configuracion-comportamiento.md](./configuracion-comportamiento.md) — **11.4**: alcance reducido a un kill-switch (`tenants.bot_paused`) — tono/estilo editable en vivo queda fuera porque rompe el prompt caching (`docs/fase-4-motor-agente/prompt-caching.md`).
- [analitica-costos.md](./analitica-costos.md) — **11.5**: tabla `llm_usage`, queries de costo/tokens, cruce con el funnel de [`metricas-cierre-ventas.md`](../fase-8-observabilidad-seguridad/metricas-cierre-ventas.md) (reusado, no duplicado).

## Mejoras posteriores al cierre de la fase

Cambios sobre el panel ya construido, que no pertenecen a ninguna sub-fase de la 11 pero viven en su mismo código (`layout()`, `STYLE_BLOCK`, `CLIENT_SCRIPT` de `src/admin/adminPanel.ts`):

- [apariencia-tema.md](./apariencia-tema.md) — selector de apariencia **Sistema / Claro / Oscuro** en el menú de cuenta. La paleta oscura ya existía bajo `prefers-color-scheme`; lo que agrega es poder elegirla a mano, con la preferencia guardada por dispositivo.
- [configuracion-por-pestanas.md](./configuracion-por-pestanas.md) — las siete secciones de Configuración pasan a **cinco pestañas**, cada una con el estado real de su área (`Activo`, `Sin definir`, `Conectado`…). Incluye el rediseño de Voz de marca, donde los `textarea` no tenían ningún estilo y el tope de 500 caracteres era invisible hasta que el formulario rebotaba.
- [colaboradores-tabla.md](./colaboradores-tabla.md) — Colaboradores era la **única tabla del panel sin `data-table`**: se le aplica la barra de búsqueda/filtros/orden/paginado del resto, el botón `+ Nuevo colaborador` de Productos y el switch de estado con confirmación. Suma el **diálogo de edición** que faltaba —hasta ahora el panel solo sabía crear una cuenta y prenderla o apagarla— e incluye dos correcciones de contenido: el teléfono deja de mostrarse como `whatsapp:+57…` y la confirmación deja de decir que una persona "deja de estar disponible para el asistente".
- [contrasena.md](./contrasena.md) — **cambiar la contraseña** desde el Perfil y **recuperarla** desde el login. El enlace de recuperación va por WhatsApp al teléfono del admin, porque el proyecto no tiene correo y sí tiene ese canal; el token se guarda hasheado, vence a los 30 minutos y sirve una sola vez.

## Orden de las sub-fases

11.1 → 11.2 → 11.3 → 11.4 → 11.5, por dependencias de layout (11.1 primero) y para dejar la tabla de escritura recurrente de 11.5 para el final, cuando el resto del panel ya esté estable. El detalle de por qué cada una va en ese orden está en el propio documento de cada sub-fase.

## Alcance explícitamente excluido de toda la Fase 11

Ver el detalle y la razón de cada uno en [mapeo-funcionalidades.md](./mapeo-funcionalidades.md#resumen-de-exclusiones-con-razón-no-omisión-silenciosa): Conocimiento/RAG, Cobros por WhatsApp, Reseñas/Campañas/Plantillas, tono/personalidad editable en vivo, Insights por IA (stretch goal).

## Riesgos

- **Costo recurrente de escritura por llamada al LLM** (`llm_usage`, Fase 11.5) — bajo volumen en el piloto actual, pero debe revisarse si el volumen de conversaciones crece antes de la Fase 10.
- **Divergencia entre `llm_usage` (Postgres) y los logs de Loki** si el insert best-effort falla silenciosamente — se documenta como comportamiento esperado (Loki sigue siendo la fuente de verdad operacional), no como bug, pero debe quedar claro en la implementación para no generar confusión al comparar ambas fuentes.
- **Expectativa del usuario vs. alcance real**: el panel de referencia sugiere mucho más de lo que esta fase entrega (Conocimiento, tono editable, Insights) — este README y `mapeo-funcionalidades.md` existen precisamente para dejar esa brecha explícita desde el diseño, no descubrirla a mitad de implementación.

## Pendiente: rediseño responsive del contenido

El layout estructural (riel de navegación, ancho completo del área principal) ya es responsive — corregido y validado en móvil/tablet tras 11.3 (colapso del menú a barra compacta con desplegable, sin overlap, sin desbordes). Lo que queda pendiente es que el **contenido de cada sección** (tablas de Productos/Pedidos/Leads/Tickets, tarjetas KPI, el inbox de dos paneles de Conversaciones) se rediseñe para pantallas angostas — hoy las tablas anchas caen a scroll horizontal contenido (`.tablewrap`), funcional pero no ideal.

Se deja explícitamente para el cierre de la Fase 11 (después de 11.4/11.5), no para cada sub-fase por separado: todas las páginas ya comparten los mismos componentes (`.tablewrap`/`data-table`, `.kpirow`, `.panel`) definidos una sola vez en `STYLE_BLOCK`/`CLIENT_SCRIPT` (`src/admin/adminPanel.ts`) — el patrón de "tabla que se convierte en cards en mobile" se diseña una vez, sobre el inventario completo de tipos de contenido, y aplica automáticamente a todo lo ya construido. Revisar antes de la Fase 9 (Piloto Controlado) si algún operador va a usar el panel desde el celular durante el piloto — si es así, esto debe subir de prioridad.

## Definición de terminado

- [ ] `tenants.display_name` y `tenants.bot_paused` agregados vía migración, con fallback/default documentados.
- [ ] Home por tenant (`GET /admin/:tenantId`) con KPI cards, actividad 7 días y marca configurable (11.1).
- [ ] Inbox de Conversaciones, tabla de Leads y listado de Tickets funcionando sobre datos reales de ForMotos (11.2).
- [ ] Vista de Flujo con contadores reales por tool y tarjeta de Conexión de WhatsApp/Twilio (11.3).
- [ ] Kill-switch de pausa del bot verificado end-to-end: un mensaje entrante con el bot pausado se guarda pero no genera respuesta automática (11.4).
- [ ] Tabla `llm_usage` escribiendo en producción, panel de Costos/Estadísticas mostrando datos reales de al menos una semana (11.5).
- [ ] `MASTER_PLAN.md` actualizado con la sección de Fase 11 (ya parte de este mismo commit de documentación).

Siguiente paso: implementación de 11.1-11.5 en ramas `feature/impl-admin-<sub-fase>` (patrón ya usado por `feature/impl-dominio-comercial`, `feature/impl-vista-asesor`, etc.), cada una con su propio PR hacia `develop`.
