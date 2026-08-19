# Fase 11.1 — Overview + KPIs + marca configurable

Nueva página `GET /admin/:tenantId` (hoy esa ruta no existe — `GET /admin` solo lista tenants, y no hay ningún home por tenant). Reemplaza el punto de entrada al panel: al elegir un tenant en `renderTenantsPage()` (`adminPanel.ts:76-82`), el operador cae aquí primero, no directo a Catálogo.

Se hace primero porque toca `layout()` (`adminPanel.ts:44-74`), compartido por **todas** las páginas del panel — resolver la marca por tenant ([ADR-016](./adrs/ADR-016-parametrizacion-marca-tenant.md)) y la navegación ampliada aquí evita retrabajo en 11.2-11.5.

## Cambios en `layout()`

- `<title>` y encabezado pasan de `"ForMotos"` fijo a `tenant.display_name ?? tenant.name` (ADR-016). Requiere que `layout()` reciba el objeto `tenant` (hoy solo recibe `tenantId: string | null`, `adminPanel.ts:44`), no solo el id — se necesita una query a `tenants` antes de renderizar cualquier página con nav.
- El `<nav>` (`adminPanel.ts:46-51`) crece con los enlaces nuevos de 11.2-11.3: Conversaciones, Leads, Tickets, Flujo, Conexiones. Configuración (11.4) y Analítica (11.5) se agregan cuando esas fases se implementen, no antes — no se debe linkear a páginas que aún no existen.

## KPI cards

Tres cards en esta fase (no cuatro): **mensajes últimas 24h**, **clientes únicos últimas 24h**, **% de mensajes resueltos sin humano**. "Costo del mes" (visible en el panel de referencia) se difiere a la [Fase 11.5](./analitica-costos.md) porque depende de la tabla `llm_usage` que esa fase introduce ([ADR-017](./adrs/ADR-017-persistencia-uso-llm-postgres.md)) — no existe ningún dato de costo persistido antes de esa fase, y mostrar un card en 0 o vacío sería peor que no mostrarlo.

```sql
-- Mensajes últimas 24h y clientes únicos últimas 24h
select
  count(*) filter (where m.created_at >= now() - interval '24 hours') as mensajes_24h,
  count(distinct c.id) filter (where m.created_at >= now() - interval '24 hours') as clientes_unicos_24h
from messages m
join conversations conv on conv.id = m.conversation_id
join customers c on c.id = conv.customer_id
where conv.tenant_id = $1;
```

`% resuelto sin humano` reusa exactamente la query de [metricas-cierre-ventas.md](../fase-8-observabilidad-seguridad/metricas-cierre-ventas.md) — específicamente `1 - (escaladas / conversaciones_totales)`, ya definida ahí como "Panel 3" para Grafana. Esta fase no la reescribe, solo la muestra también en el panel admin, con la misma ventana de tiempo (últimos 7 días, `and c.closed_at >= now() - interval '7 days'`).

## Actividad — últimos 7 días (barras SVG)

```sql
select date_trunc('day', m.created_at)::date as dia, count(*) as mensajes
from messages m
join conversations conv on conv.id = m.conversation_id
where conv.tenant_id = $1
  and m.created_at >= now() - interval '7 days'
group by 1
order by 1;
```

Renderizado como SVG generado en el servidor (mismo criterio de [ADR-014](./adrs/ADR-014-arquitectura-frontend-panel.md): sin librería de charting para un caso de una sola serie) — un `<rect>` por día, altura proporcional al máximo del rango, mismo patrón de interpolación que ya usa `formatCOP()` (`adminPanel.ts:40-42`).

## Conversaciones recientes

Lista de las últimas N conversaciones con su último mensaje, ordenadas por `messages.created_at desc`. Reusa el patrón de lectura de `messages`/`conversations` que ya existe en [`handoffView.ts`](../fase-7-escalamiento-humano/vista-asesor.md) para render de historial — no se reescribe la lógica de mostrar contenido de mensaje, se extrae a un helper compartido si el detalle de conversación de la [Fase 11.2](./conversaciones-leads-tickets.md) lo necesita también (evaluar en implementación si vale la pena mover `renderMessageBody()` a `src/admin/shared/`).

## Qué no cubre esta fase

- **Costo del mes** — depende de `llm_usage` ([Fase 11.5](./analitica-costos.md)).
- **"Salud del bot" / "Estado del agente"** (tickets abiertos, canales conectados, modelo activo, tools activas) del panel de referencia — corresponde a las [Fases 11.2 y 11.3](./flujo-conexiones.md), que introducen los datos de Tickets/Conexiones/Flujo que esta card resumiría. Se agrega a esta página del Overview recién cuando esas fases existan, para no mostrar un resumen de algo que el panel aún no tiene.
- **"Mejoras sugeridas"** del panel de referencia — requiere el subsistema de Conocimiento/RAG, explícitamente fuera de alcance de toda la Fase 11 (ver [mapeo-funcionalidades.md](./mapeo-funcionalidades.md)).

## Extension: selector de periodo y KPIs del Resumen

`renderOverviewPage` ahora acepta `?periodo=7|15|30` (default 7) y muestra KPIs en esa ventana, comparados contra la ventana inmediatamente anterior del mismo largo (chip de tendencia "vs. periodo anterior"). Se agrega un KPI nuevo "Conversaciones nuevas" además de los originales (mensajes, clientes únicos, % resuelto sin humano). El gráfico SVG de actividad se re-renderiza con tantos buckets como días del periodo elegido.

KPIs del Resumen por periodo:

| KPI | Query |
|-----|-------|
| Mensajes | `count(*)` de `messages` en la ventana |
| Clientes únicos | `count(distinct conv.customer_id)` en la ventana |
| Conversaciones nuevas | `count(*)` de `conversations.started_at` en la ventana |
| % resuelto sin humano | `1 - escaladas / conversaciones_totales` (funnel de metricas-cierre-ventas.md) sobre cerradas en la ventana |

## Análisis de la BD (datos piloto, ~30 días)

Exploración con la skill `data-analysis` contra la BD local (4 ago – 19 ago 2026):

- **Actividad**: 317 mensajes, 33 conversaciones, 26 clientes, 3 pedidos ($1.42M COP), 249 llamadas LLM (deepseek-chat, $0.60 USD acumulado).
- **Funnel (7 cerradas)**: 1 con pedido, 2 con cotización, 4 escaladas, 3 sin actividad → tasa de cierre 14.3%, cotización→pedido 50%.
- **Escalamientos**: 8 tickets (6 resueltos, 2 abiertos), motivos: solicitud_cliente (5), intentos_fallidos (2), queja (1); tiempo promedio de resolución ~2.8 h.
- **Bot**: latencia p50 ~2.0 s, p95 ~3.3 s, ~8.4K tokens/llamada.
- **Satisfacción**: 2 calificaciones, ambas 5.0.
- **Canales**: whatsapp (15 conv) e instagram (1 conv).

Estos valores informan las metas y umbrales de la Analítica (índice de objetivo).
