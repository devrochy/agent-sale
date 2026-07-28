# Métricas de Cierre de Ventas

Ver [ADR-011](./adrs/ADR-011-metricas-negocio.md) para la decisión de fuente de datos (Postgres, no Loki). Este documento define el funnel exacto y valida que el dato ya disponible alcanza para calcularlo, sin instrumentación nueva.

## Por qué

La [Fase 0](../fase-0-descubrimiento.md#4-criterios-de-éxito-del-mvp) fija dos criterios de éxito del piloto que hoy no tienen dónde verse:

- **% de mensajes resueltos sin humano** — objetivo ≥ 60%.
- **Pedidos cerrados por semana** — igual o mayor al baseline manual.

El dashboard de ADR-009 (Loki) cubre latencia, tasa de escalamiento y costo — no responde "¿cuántas conversaciones terminan en una venta?". Este documento cierra ese hueco antes de que la Fase 9 (Piloto Controlado) necesite reportar contra esos criterios.

## El funnel

Cada conversación cerrada (`conversations.status = 'closed'`) cae en exactamente una de estas categorías:

1. **Con pedido** (`orders.conversation_id`) — venta cerrada por el agente.
2. **Escalada, sin pedido** (`handoff_queue.conversation_id`, sin `orders`) — pasó a un asesor humano; si el asesor cierra la venta offline, este sistema no lo ve (ver "qué no cubre").
3. **Con cotización, sin pedido ni escalamiento** (`quotes.conversation_id`) — el cliente vio precios y no volvió.
4. **Sin actividad comercial** — ni cotización, ni pedido, ni escalamiento (abandono temprano, o la conversación no llegó a ese punto).

```
conversaciones_totales
 ├─ con_pedido           → tasa_cierre = con_pedido / conversaciones_totales
 ├─ escaladas (sin pedido)
 ├─ con_cotizacion (sin pedido, sin escalar)
 └─ sin_actividad_comercial
```

## Query de referencia

Validada manualmente contra datos sintéticos (4 conversaciones cubriendo las 4 categorías) — el resultado coincidió exactamente con lo esperado, sin necesitar ningún cambio de esquema.

```sql
select
  t.name as tenant,
  count(distinct c.id) as conversaciones_totales,
  count(distinct q.conversation_id) as con_cotizacion,
  count(distinct o.conversation_id) as con_pedido,
  count(distinct h.conversation_id) as escaladas,
  count(distinct c.id) filter (
    where q.conversation_id is null
      and o.conversation_id is null
      and h.conversation_id is null
  ) as sin_actividad_comercial,
  round(
    100.0 * count(distinct o.conversation_id) / nullif(count(distinct c.id), 0),
    1
  ) as tasa_cierre_pct
from conversations c
join tenants t on t.id = c.tenant_id
left join quotes q on q.conversation_id = c.id
left join orders o on o.conversation_id = c.id
left join handoff_queue h on h.conversation_id = c.id
where c.status = 'closed'
group by t.name;
```

Con un rango de fechas (para el reporte semanal de la Fase 9), agregar `and c.closed_at >= now() - interval '7 days'`.

## Panel de Grafana

- Datasource: Postgres nativo de Grafana (no Loki), apuntando a Supabase (ADR-006) — ver consecuencias de alcance de red en [ADR-011](./adrs/ADR-011-metricas-negocio.md).
- Panel 1: tasa de cierre (`tasa_cierre_pct`) como serie de tiempo semanal, variable de plantilla `tenant`.
- Panel 2: barras apiladas de las 4 categorías del funnel por semana, para ver si el "no cierre" se concentra en abandono temprano o en cotizaciones que no avanzan.
- Panel 3 (derivado de "% de mensajes resueltos sin humano" de la Fase 0): `1 - (escaladas / conversaciones_totales)`.

## Qué no cubre esto

- **Ventas cerradas offline por un asesor humano tras escalar.** El sistema solo ve `orders` creadas por la tool `crear_pedido` del agente. Si un asesor cierra la venta por fuera de WhatsApp/el sistema, esa conversación queda contada como "escalada, sin pedido" aunque haya sido una venta real. Corregir esto requeriría que la vista del asesor ([Fase 7](../fase-7-escalamiento-humano/vista-asesor.md)) permita registrar el resultado de una conversación escalada — fuera de alcance de este documento, se anota como mejora futura si el dato resulta relevante en el piloto.
- **Costo por conversación / rentabilidad** — ya cubierto por el dashboard operacional de ADR-009 (tokens/costo vía Loki); este documento solo agrega el lado de "¿se convirtió en venta?", no el costo de haberla atendido. Cruzar ambos (costo vs. resultado) es un análisis manual en la Fase 9, no un panel nuevo.
- **Instrumentación de código** — no hace falta ninguna; el dato ya lo generan las Fases 6 y 7 como parte del flujo normal.
