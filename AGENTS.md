# AGENTS.md — Convenciones del proyecto

Plataforma de ventas asistida por IA sobre WhatsApp (Claude + Tool Calling). Panel admin server-rendered en `src/admin/adminPanel.ts`, sin framework frontend.

## Skills especializadas

Estas skills están instaladas globalmente (`~/.agents/skills/`) y deben cargarse cuando el trabajo toque su dominio:

- **`data-analysis`** — análisis de información, insights, estadísticas y reportes. Úsala para explorar datos de la BD, interpretar métricas, detectar tendencias o responder preguntas del tipo "¿qué dicen estos datos?". Orientada a Excel/CSV pero sus patrones de análisis aplican a cualquier dataset.
- **`kpi-dashboard-design`** — selección de KPIs, diseño de dashboards y visualización. Úsala al decidir qué métricas mostrar a un administrador, definir metas/umbrales (ej. Fase 0: ≥60% resuelto sin humano), jerarquizar tarjetas o diagnosticar métricas contradictorias. Referencias en `~/.agents/skills/kpi-dashboard-design/references/details.md`.
- **`build-dashboard`** — generar dashboards HTML autocontenidos (Chart.js embebido, sin servidor). Úsala cuando el pedido sea un dashboard/HTML navegable de una sola vez, no una página del panel admin (las páginas del panel se hacen server-rendered en `adminPanel.ts`, ver abajo).

## Convenciones del panel admin

- **Server-rendered sin librerías de charting**: las gráficas son SVG generadas en el servidor (mismo patrón de `#chartWrap` en `renderOverviewPage`/`renderAnaliticaPage`). No agregar librerías de charts.
- **Queries dentro de `withTransaction`** (`src/shared/db/withTransaction.ts`), igual que `renderOverviewPage` y `renderAnaliticaPage`. No filtrar por `tenant_id` (multi-tenancy eliminado, ver migraciones 0035-0036).
- **Fechas**: usar `to_char(date_trunc('day', created_at), 'YYYY-MM-DD')` en vez de `::date` — el driver de pg parsea columnas `date` como objeto Date, no string, y el cliente consume esto como JSON.
- **Moneda**: costos en USD en BD; el panel convierte con `formatMoney(..., moneda)` y `?moneda=` (ver `renderAnaliticaPage`). El costo/tokens por conversación se lee del acumulado en `conversations.costo_total_usd` (migración 0057), no se recomputa `llm_usage`.
- **Hints**: fragmentos cortos tipo unidad ("últimas 10", "USD / día"), no oraciones.
- **Estados/funnel**: reusar `CONVERSACION_FUNNEL_ESTADO_SQL` y el funnel de `docs/fase-8-observabilidad-seguridad/metricas-cierre-ventas.md` — no reimplementar.
- **Seguridad**: escapar HTML con `escapeHtml()`. El panel usa sesiones firmadas, RLS por sesión (`app.tenant_id`), y no debe loguear secretos.

## Comandos

- `npm run migrate` — aplicar migraciones (`node-pg-migrate`, requiere `MIGRATIONS_DATABASE_URL`).
- `npm run build` — `tsc -p tsconfig.json` (typecheck).
- `npm run lint` — ESLint sobre `src tests scripts`.
- `npm test` / `npm run test:all` — vitest unit / todas.
- `npm run format:write` — prettier.

## Base de datos

- Local: `localhost:5432` (contenedor `agent-sale-postgres-1`). `DATABASE_URL` = rol de aplicación, `MIGRATIONS_DATABASE_URL` = rol admin.
- Tablas clave: `conversations`, `messages`, `customers`, `quotes`/`quote_items`, `orders`/`order_items`, `handoff_queue`, `llm_usage`, `reviews`, `channel_connections`, `products`/`product_variants`/`inventory`, `promotions`.