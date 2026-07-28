# ADR-011: Fuente de datos para métricas de negocio (cierre de ventas)

## Estado
Aceptado.

## Contexto
[ADR-009](./ADR-009-observabilidad.md) definió Grafana Cloud + Loki (logs estructurados) como base de las métricas *operacionales* del sistema (latencia, tasa de escalamiento, tokens/costo por tenant) — datos que nacen como eventos durante el procesamiento de un turno y no tienen otro lugar natural donde vivir.

Los criterios de éxito de la [Fase 0](../../fase-0-descubrimiento.md#4-criterios-de-éxito-del-mvp) incluyen dos métricas de negocio que ADR-009 no cubría explícitamente: **% de mensajes resueltos sin humano** y **pedidos cerrados por semana**. A diferencia de la latencia o el conteo de tokens, estos datos ya existen como registros transaccionales completos en Postgres — `conversations`, `quotes`, `orders` y `handoff_queue` (Fases 3, 6 y 7) — no como eventos efímeros que solo tienen sentido si se loguean.

## Opción evaluada: reutilizar Loki (agregar un evento de log `venta.cerrada`)

Consistente con ADR-009, pero requiere: (a) instrumentar un punto nuevo de logging en el punto exacto donde se considera "cerrada" una conversación (ambiguo — puede pasar en el orquestador al crear el pedido, o nunca, si el cliente abandona sin que el sistema lo note), y (b) mantener esa lógica sincronizada con lo que las tablas de negocio ya representan, con riesgo de que diverjan (ej. un pedido se anula después vía Postgres directo y el log ya emitido queda desactualizado).

## Decisión
**Usar Postgres directamente como fuente de verdad de las métricas de negocio**, vía un datasource Postgres nativo de Grafana (Grafana soporta Postgres como datasource de primera clase, no solo Loki). El funnel de cierre se calcula con una consulta SQL sobre `conversations` LEFT JOIN `quotes`/`orders`/`handoff_queue`, sin instrumentación nueva en el código — la Fase 6 y 7 ya generan estos registros como parte del flujo normal.

Esto separa responsabilidades con ADR-009: **Loki para lo operacional** (algo pasó durante el procesamiento, efímero, útil para debugging), **Postgres para lo transaccional** (algo es verdad sobre el negocio, durable, es la fuente de verdad por definición — es la misma tabla que usa `crear_pedido` para no duplicar inventario). Evita mantener dos copias de la misma verdad.

Como complemento — no reemplazo — se mantiene el log ya existente `orchestrator.tool_completada` (tool `crear_pedido`) para correlacionar por `conversation_id` en Explore durante debugging en tiempo real; no se usa para agregación ni dashboards.

## Consecuencias
- Requiere agregar un datasource Postgres en Grafana Cloud apuntando a la base de producción (Supabase, ADR-006). En Fly.io/Supabase esto es alcanzable directamente; en desarrollo local **no** es alcanzable desde Grafana Cloud sin un túnel — el panel de negocio solo es útil contra staging/producción, no como parte del flujo de prueba local de `observability/README.md`.
- El dashboard de negocio queda como un datasource separado del dashboard operacional (Loki) dentro del mismo stack de Grafana Cloud — dos datasources, un solo lugar de visualización.
- Si en el futuro se necesita una vista de negocio para el propio dueño del negocio (no solo el equipo técnico), evaluar si conviene envolver esta misma query en la vista del asesor ([Fase 7](../fase-7-escalamiento-humano/vista-asesor.md)) en vez de pedirle a un no técnico que use Grafana — fuera de alcance de esta decisión, se anota como pendiente futuro.
