# Fase 11.5 — Analítica (Costos/Estadísticas nativos en Postgres)

**Implementado.** Cierra la Fase 11 (11.1-11.4 ya mergeadas, incluyendo la extensión "Comportamiento del agente" — Tono/Estilo/Velocidad/Cerebro, ver [ADR-021](./adrs/ADR-021-tono-personalizable-cache-jerarquico.md)/[ADR-022](./adrs/ADR-022-debounce-velocidad-respuesta.md)/[ADR-023](./adrs/ADR-023-ruteo-automatico-dificultad.md)). El hueco que este documento dejaba pendiente ("de dónde sale `model`") quedó cerrado gratis por esa misma serie: `resolveLlmProviderForTenant` (ADR-020/021/023) ya devuelve `model`/`providerKey`/`dificultad` por turno, `src/orchestrator/loop.ts` ya los tiene en scope justo donde loguea `orchestrator.llm_completado` — no hizo falta ninguna inferencia manual.

Fuente de datos decidida en [ADR-017](./adrs/ADR-017-persistencia-uso-llm-postgres.md): persistir en Postgres, no embeber Grafana ni consultar Loki en vivo desde el panel — evita acoplar la latencia de carga del panel a una query de logs externa.

## Tabla `llm_usage`

Migración real: `migrations/0023_llm_usage.cjs` (no `0018` como preveía la estimación original de ADR-017 — otras columnas de `tenants` de la Fase 11.4 extendida tomaron los números 0018-0022 primero; confirma la nota que ya dejaba esa ADR sobre que el número exacto se resolvería en implementación).

```sql
create table llm_usage (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  conversation_id uuid references conversations(id),
  provider text not null,   -- providerKey del catálogo o "env-default" — gratis desde ADR-020
  model text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  latency_ms integer not null,
  cost_usd numeric(10,6),
  created_at timestamptz not null default now()
);
create index on llm_usage (tenant_id, created_at);

-- RLS explícito (0010_rls_policies.cjs solo corrió una vez, contra las
-- tablas que existían en ese momento — cualquier tabla tenant-scoped
-- nueva necesita su propio ENABLE/FORCE + policy, mismo patrón):
alter table llm_usage enable row level security;
alter table llm_usage force row level security;
create policy tenant_isolation on llm_usage
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

`provider` se agregó al diseño original (no estaba en la primera versión de este documento) porque ADR-020 ya lo devuelve gratis en `ResolvedLlmProvider.providerKey` — no tenía sentido guardar `model` sin el proveedor al que pertenece, sobre todo con IDs de modelo que podrían repetirse entre proveedores en el futuro.

## Punto de escritura

Junto al log existente en `src/orchestrator/loop.ts` (evento `orchestrator.llm_completado`, dentro de `processConversation`), un insert best-effort a `llm_usage` vía `withTenant` — un fallo al escribir esta fila (capturado en un `try/catch` propio, logueado como `orchestrator.llm_usage_insert_fallido`) no interrumpe la respuesta al cliente; el log a Loki sigue siendo la fuente de verdad operacional, esta tabla es un espejo de negocio derivado, no la fuente primaria.

`model`/`provider` ya vienen resueltos por `resolveLlmProviderForTenant` (ADR-020/021/023), destructurados en el mismo scope donde ya se arma el log — no hizo falta ninguna inferencia adicional, a diferencia de lo que este documento asumía originalmente. `cost_usd` se calcula con `calculateCost` (`src/shared/pricing.ts`, nuevo) — `null` si el modelo no está en el mapa de precios, no bloquea el insert.

## Queries del panel

`renderAnaliticaPage` corre estas queries dentro de `withTenant(tenantId, ...)`, igual que el resto de `adminPanel.ts` — el `SET LOCAL app.tenant_id` de esa sesión ya scopea las filas vía RLS, así que no llevan un `where tenant_id = $1` explícito (a diferencia de como se había bosquejado originalmente aquí; el patrón real es el mismo que ya usan `renderOverviewPage`/`renderTicketsPage`, no uno nuevo).

**Costo y tokens del mes:**
```sql
select
  date_trunc('month', created_at) as mes,
  sum(input_tokens) as tokens_entrada,
  sum(output_tokens) as tokens_salida,
  sum(cost_usd) as costo_usd
from llm_usage
where created_at >= date_trunc('month', now())
group by 1;
```

**Tendencia diaria (para el mismo tipo de gráfico SVG de barras que [Fase 11.1](./overview-kpis.md#actividad--últimos-7-días-barras-svg)):**
```sql
select date_trunc('day', created_at)::date as dia, sum(cost_usd) as costo_usd, sum(input_tokens + output_tokens) as tokens
from llm_usage
where created_at >= now() - interval '30 days'
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
where c.status = 'closed'
group by 1;
```

(igual que las anteriores, corre dentro de `withTenant` — sin `where c.tenant_id = $1` explícito.)

## Selector de moneda

Agregado tras QA con el usuario: `cost_usd` en Postgres siempre queda en USD (es lo que factura cada proveedor de LLM), pero el panel permite elegir la moneda de visualización vía `?moneda=` (USD/COP/MXN/ARS/CLP/PEN/BRL) — no persistida por tenant, puramente de lectura.

`src/shared/exchangeRates.ts` (nuevo) resuelve la tasa contra [open.er-api.com](https://open.er-api.com) (sin API key, actualiza diario), con caché en memoria del proceso de 12h — evita depender de la red externa en cada carga de página. Si el fetch falla y no hay caché previo, `renderAnaliticaPage` degrada a USD y muestra un aviso ("No se pudo obtener la tasa de cambio en vivo"), en vez de inventar un número.

La conversión se hace en el server antes de renderizar (KPIs, gráfico de tendencia y costo por resultado) — el gráfico SVG compartido con Resumen (`CLIENT_SCRIPT`, `#chartWrap`) recibe la moneda vía `data-format="money"`/`data-symbol`/`data-decimals`/`data-money-suffix` en vez del `data-format="usd"` hardcodeado de la primera versión.

### "Costo promedio por resultado": conteo, no frase suelta

Tras QA visual el hint del bloque decía literalmente "conversaciones cerradas" — no encajaba con el resto de la página, donde los hints son fragmentos cortos tipo unidad ("USD / día", "últimas 10", "BYOK"), no oraciones. Se cambió a un conteo (`"N cerradas"`), igual que ya hacía el hint de "Conversaciones recientes" en Resumen. La query de `costoPorResultado` ahora también trae `count(u.total_costo)` (no `count(*)`: la LATERAL siempre devuelve una fila por conversación cerrada aunque no tenga uso de LLM, y contar esas inflaría el número real de conversaciones detrás del promedio).

De paso se corrigió la tarjeta KPI "Costo promedio · conversación con pedido", que decía "Últimas conversaciones cerradas" — la query nunca tuvo `LIMIT`, promedia *todas* las conversaciones cerradas con pedido, así que "Últimas" era información falsa. Ahora muestra el conteo real (ej. "1 conversación cerrada").

## Insights por IA (stretch goal, no comprometido)

Resumen de conversación por LLM (qué quería el cliente, objeciones, oportunidad de venta) — factible con los datos ya disponibles (`messages` completo por conversación), pero implica una llamada nueva al LLM por conversación cerrada, con costo recurrente que esta misma fase ahora puede medir con precisión (`llm_usage`) antes de comprometerse a pagarlo. Se documenta como candidato a implementar después de tener al menos una semana de datos reales de costo — no se agenda dentro del alcance comprometido de la Fase 11.

## Qué no cubre esta fase

- Percentiles de latencia operacional (p50/p95) a nivel de infraestructura — sigue en Grafana/Loki (ADR-009), no se duplica.
- Insights por IA — ver arriba, stretch goal.
- Tope de presupuesto mensual configurable (mencionado en el panel de referencia) — se puede construir sobre esta misma tabla en una iteración posterior una vez haya datos reales de gasto para calibrar umbrales razonables; no se diseña sin ese dato.
