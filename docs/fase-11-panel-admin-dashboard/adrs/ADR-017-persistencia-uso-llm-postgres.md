# ADR-017: Fuente de datos para Costos/Estadísticas del panel

## Estado
Aceptado.

## Contexto
Hoy los tokens y la latencia de cada llamada al LLM se loguean pero no se persisten transaccionalmente: `src/orchestrator/loop.ts:184-200` emite el evento `orchestrator.llm_completado` con `latency_ms`, `stop_reason` y `usage` (`inputTokens`, `outputTokens`, y opcionalmente `cacheReadTokens`/`cacheCreationTokens`, ver `src/orchestrator/llm/types.ts:27-32`) — pero **ese log solo vive en Loki** (Grafana Cloud, vía Alloy). Ninguna tabla de Postgres guarda este dato. Además, **ese log no incluye qué modelo se usó** — no hay campo `model` en `Usage` ni en `TurnResponse`.

`docs/fase-8-observabilidad-seguridad/adrs/ADR-011-metricas-negocio.md` ya fijó el criterio "Postgres para lo transaccional/negocio, Loki para lo operacional" al decidir que el funnel de cierre de ventas se calcula con SQL nativo, no con LogQL. La pregunta de esta ADR es dónde cae "Costos/Estadísticas" (tokens, gasto en USD, latencia) del panel de la Fase 11: ¿es "negocio" (Postgres) u "operacional" (Loki)?

## Opciones consideradas

1. **Consultar la API de Loki en vivo** desde el backend de Fastify cada vez que se abre la página de Costos/Estadísticas del panel. No requiere ningún cambio de escritura, reusa el dato que ya existe. Pero acopla el tiempo de respuesta del panel a la latencia de una query de logs sobre un rango de tiempo (no es instantánea), y si Loki está lento o caído, la página del panel también lo está — un nuevo punto de falla en el request path de una herramienta operativa.
2. **Embeber paneles de Grafana Cloud ya existentes** (`observability/dashboard.json`, ADR-009) vía iframe. Cero trabajo de backend nuevo, pero sigue dependiendo de que Grafana Cloud esté embebible en el navegador del cliente que abre el panel, y no permite mezclar esas métricas con datos de negocio (ej. "costo por conversación cerrada") sin salir del panel.
3. **Persistir un registro de uso de LLM en Postgres**, escrito junto al log existente en `orchestrator.llm_completado`. Requiere una tabla nueva y una escritura adicional por llamada al LLM (volumen bajo en el piloto: ~decenas de llamadas/día), pero deja las queries del panel como agregados locales de Postgres — rápidas, sin dependencia externa en tiempo de request, y cruzables con `conversations`/`orders` para análisis de costo-por-venta.

## Decisión
**Opción 3: persistir uso de LLM en Postgres**, evaluada explícitamente en el eje de rendimiento del panel: una consulta a Loki en vivo (opción 1) es la peor opción porque agrega latencia variable e indisponibilidad externa al path de carga del panel; el iframe (opción 2) es rápido pero no compone con datos propios. Persistir en Postgres es la única opción que da queries rápidas y propias sin dependencia externa en el momento en que alguien abre la página.

### Esquema propuesto
Tabla `llm_usage` (migración nueva, siguiente número libre tras `0017_products_media.cjs` → `0018_llm_usage.cjs`):

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

Dos huecos que el código actual no cubre y que esta tabla obliga a resolver explícitamente:
- **`model` no viene en el log actual** (`orchestrator.llm_completado` no lo incluye) — el punto de escritura debe leerlo de la config activa (`env.llmModel`/proveedor Anthropic vs `openai_compatible`, ver `src/config/env.ts`) en el momento de la llamada, no inferirlo después.
- **No existe cálculo de costo en ningún punto del código hoy** — `cost_usd` requiere una tabla de precios por modelo (USD por 1K tokens de entrada/salida) que tampoco existe. Se documenta como parte del alcance de [analitica-costos.md](../analitica-costos.md), no se asume resuelto por esta ADR.

## Consecuencias
- El insert a `llm_usage` se agrega junto al log existente en `loop.ts:184-200`, best-effort (un fallo al escribir esta fila no debe interrumpir la respuesta al cliente — el log a Loki sigue siendo la fuente de verdad operacional).
- El funnel de cierre de ventas sigue usando literalmente la query de [metricas-cierre-ventas.md](../../fase-8-observabilidad-seguridad/metricas-cierre-ventas.md) — esta ADR no la duplica, solo agrega la pieza de costo que ese documento explícitamente dejaba fuera de alcance ("Costo por conversación / rentabilidad — ya cubierto por el dashboard operacional de ADR-009").
- Loki/Grafana siguen siendo la fuente para lo que no tiene sentido duplicar en Postgres (trazas completas, debugging de errores) — esta ADR no reemplaza `observability/dashboard.json`, solo cubre la porción de costo/tokens que el panel admin necesita mostrar rápido y cruzado con datos de negocio.
