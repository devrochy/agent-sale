# Fase 11.5 — Analítica (Costos/Estadísticas nativos en Postgres)

Va último porque depende de que 11.1-11.3 ya hayan establecido el layout/navegación del panel completo, y porque introduce la única tabla nueva de escritura recurrente de esta fase — conviene que el resto del panel ya esté estable antes de agregar un punto de escritura por cada llamada al LLM.

Fuente de datos decidida en [ADR-017](./adrs/ADR-017-persistencia-uso-llm-postgres.md): persistir en Postgres, no embeber Grafana ni consultar Loki en vivo desde el panel — evita acoplar la latencia de carga del panel a una query de logs externa.

## Tabla `llm_usage`

Migración `0018_llm_usage.cjs` (siguiente número libre tras `0017_products_media.cjs`; si [ADR-016](./adrs/ADR-016-parametrizacion-marca-tenant.md)/[configuracion-comportamiento.md](./configuracion-comportamiento.md) ya tomaron ese número con sus columnas de `tenants`, esta migración toma el siguiente disponible en el momento de implementar — el orden exacto se resuelve en implementación, no aquí):

```sql
create table llm_usage (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  conversation_id uuid references conversations(id),
  model text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  latency_ms integer not null,
  cost_usd numeric(10,6),
  created_at timestamptz not null default now()
);
create index on llm_usage (tenant_id, created_at);
```

## Punto de escritura

Junto al log existente en `src/orchestrator/loop.ts:184-200` (evento `orchestrator.llm_completado`), agregar un insert best-effort a `llm_usage` — un fallo al escribir esta fila no debe interrumpir la respuesta al cliente; el log a Loki sigue siendo la fuente de verdad operacional, esta tabla es un espejo de negocio derivado, no la fuente primaria.

Dos datos que el log actual no trae y que este insert debe resolver explícitamente en el momento de la llamada (no inferirlos después, porque no quedarían registrados en ningún otro lado):

- **`model`** — no está en `Usage`/`TurnResponse` (`src/orchestrator/llm/types.ts:27-39`). Se lee de la config activa del proveedor en el momento de la llamada (`env.LLM_PROVIDER`/`env.LLM_MODEL` para `openai_compatible`, o el modelo Anthropic configurado para el proveedor `anthropic`).
- **`cost_usd`** — no existe ningún cálculo de costo en el código hoy. Requiere una tabla (o mapa en código) de precios por modelo, USD por 1K tokens de entrada/salida — se agrega como parte de esta fase (`src/shared/pricing.ts` o similar, con los precios vigentes del/los modelo(s) en uso), no se asume que ya existe.

## Queries del panel

**Costo y tokens del mes:**
```sql
select
  date_trunc('month', created_at) as mes,
  sum(input_tokens) as tokens_entrada,
  sum(output_tokens) as tokens_salida,
  sum(cost_usd) as costo_usd
from llm_usage
where tenant_id = $1
  and created_at >= date_trunc('month', now())
group by 1;
```

**Tendencia diaria (para el mismo tipo de gráfico SVG de barras que [Fase 11.1](./overview-kpis.md#actividad--últimos-7-días-barras-svg)):**
```sql
select date_trunc('day', created_at)::date as dia, sum(cost_usd) as costo_usd, sum(input_tokens + output_tokens) as tokens
from llm_usage
where tenant_id = $1 and created_at >= now() - interval '30 days'
group by 1 order by 1;
```

**Latencia p50/p95** — mismo criterio de no reinventar lo que ya vive bien en Loki: `latency_ms` se guarda en `llm_usage` para poder cruzarlo con costo/conversación en el panel de negocio, pero el detalle fino de percentiles/latencia operacional sigue siendo responsabilidad de `observability/dashboard.json` (Grafana/Loki, ADR-009) — no se duplica ese panel aquí.

## Funnel de cierre de ventas

Esta fase **no reimplementa** el funnel — reusa literalmente la query de [metricas-cierre-ventas.md](../fase-8-observabilidad-seguridad/metricas-cierre-ventas.md), ya mostrada también en el Overview de la [Fase 11.1](./overview-kpis.md). Aquí se agrega la vista que ese documento dejaba explícitamente pendiente: **costo por conversación cerrada**, ahora posible cruzando `llm_usage.conversation_id` con el resultado del funnel — algo que el propio `metricas-cierre-ventas.md` marcó como "análisis manual en la Fase 9, no un panel nuevo" porque el dato de costo no existía en Postgres todavía.

```sql
select
  case when o.id is not null then 'con_pedido' else 'sin_pedido' end as resultado,
  round(avg(u.total_costo), 4) as costo_promedio_usd
from conversations c
left join orders o on o.conversation_id = c.id
join lateral (
  select sum(cost_usd) as total_costo from llm_usage where conversation_id = c.id
) u on true
where c.tenant_id = $1 and c.status = 'closed'
group by 1;
```

## Insights por IA (stretch goal, no comprometido)

Resumen de conversación por LLM (qué quería el cliente, objeciones, oportunidad de venta) — factible con los datos ya disponibles (`messages` completo por conversación), pero implica una llamada nueva al LLM por conversación cerrada, con costo recurrente que esta misma fase ahora puede medir con precisión (`llm_usage`) antes de comprometerse a pagarlo. Se documenta como candidato a implementar después de tener al menos una semana de datos reales de costo — no se agenda dentro del alcance comprometido de la Fase 11.

## Qué no cubre esta fase

- Percentiles de latencia operacional (p50/p95) a nivel de infraestructura — sigue en Grafana/Loki (ADR-009), no se duplica.
- Insights por IA — ver arriba, stretch goal.
- Tope de presupuesto mensual configurable (mencionado en el panel de referencia) — se puede construir sobre esta misma tabla en una iteración posterior una vez haya datos reales de gasto para calibrar umbrales razonables; no se diseña sin ese dato.
