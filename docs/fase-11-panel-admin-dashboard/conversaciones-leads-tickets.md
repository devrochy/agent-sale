# Fase 11.2 — Conversaciones + Leads + Tickets

Depende de la [Fase 11.1](./overview-kpis.md) solo por el `layout()`/nav compartido, no por datos — las tres vistas de esta fase leen tablas que ya existen y no necesitan nada que 11.1 introduzca.

## Conversaciones (`GET /admin/:tenantId/conversaciones`)

Inbox de dos paneles (lista + detalle), patrón htmx de [ADR-014](./adrs/ADR-014-arquitectura-frontend-panel.md): la lista de la izquierda pide el detalle de una conversación con `hx-get` a `GET /admin/:tenantId/conversaciones/:id/fragmento`, que devuelve solo el panel derecho.

**Lista:** una fila por `conversations`, con `customers.name ?? customers.phone_number`, y el `content` del último `messages` de esa conversación (truncado), ordenadas por el `created_at` de ese último mensaje.

**Detalle:** todos los `messages` de la conversación en orden, reusando el criterio de [`vista-asesor.md`](../fase-7-escalamiento-humano/vista-asesor.md) de mostrar también qué tool se ejecutó en cada turno (`messages.tool_calls`, que guarda los bloques `ContentBlock` del mensaje `assistant`, incluyendo `tool_use` con `name`/`input` — ver `src/orchestrator/memory.ts:92`), no solo el texto plano.

**Filtros por tab — alcance reducido frente al panel de referencia.** El panel de referencia ofrece tabs "Leads / Atención / Molestos / Contentos", pero "Molestos"/"Contentos" requiere clasificación de sentimiento que no existe en ningún punto del código (no hay NLP de sentimiento, ni score guardado en `messages`/`conversations`). Implementar esos dos tabs sería inventar un dato, no mostrar uno real. Los tabs de esta fase se basan en datos existentes:

- **Todas** — sin filtro.
- **Abiertas** — `conversations.status = 'open'`.
- **Escaladas** — tiene fila en `handoff_queue` (ver Tickets, abajo).
- **Cerradas** — `conversations.status = 'closed'`.

Clasificación de sentimiento queda anotada como posible extensión futura (requeriría, como mínimo, una tool o un job de post-proceso que analice `content` y escriba un campo nuevo — no se diseña aquí sin caso de uso concreto que lo pida).

## Leads (`GET /admin/:tenantId/leads`)

El panel de referencia pide fecha, nombre, contacto, resumen y estado — pero `customers` no tiene ningún campo de resumen ni de estado de lead (`migrations/0003_customers.cjs`: solo `phone_number`, `name`, `created_at`). Ninguno de los dos se inventa con IA nueva; ambos se **derivan** de datos que ya existen:

- **Resumen** — el `content` del mensaje inbound más reciente de esa conversación (heurística simple, no un resumen generado por LLM — evita el costo recurrente que [mapeo-funcionalidades.md](./mapeo-funcionalidades.md) marca como fuera de alcance para Insights).
- **Estado** — reusa las mismas 4 categorías del funnel de [metricas-cierre-ventas.md](../fase-8-observabilidad-seguridad/metricas-cierre-ventas.md) (`sin_actividad_comercial`, `con_cotizacion`, `escalada`, `con_pedido`), aplicadas por cliente en vez de por conversación — evita definir un segundo concepto de "estado de lead" paralelo al que ya existe para el funnel de ventas.

```sql
select
  c.id, c.name, c.phone_number, c.created_at,
  m.content as ultimo_mensaje,
  case
    when o.customer_id is not null then 'con_pedido'
    when h.customer_id is not null then 'escalada'
    when q.customer_id is not null then 'con_cotizacion'
    else 'sin_actividad_comercial'
  end as estado
from customers c
left join lateral (
  select content from messages msg
  join conversations conv on conv.id = msg.conversation_id
  where conv.customer_id = c.id and msg.direction = 'inbound'
  order by msg.created_at desc limit 1
) m on true
left join (select distinct customer_id from orders) o on o.customer_id = c.id
left join (select distinct conv.customer_id from handoff_queue h join conversations conv on conv.id = h.conversation_id) h on h.customer_id = c.id
left join (select distinct customer_id from quotes) q on q.customer_id = c.id
where c.tenant_id = $1
order by c.created_at desc;
```

**Exportar CSV**: serializa el mismo resultado de la query anterior — sin dependencia nueva, un `content-type: text/csv` armado a mano igual que el resto del panel arma HTML a mano.

## Tickets (`GET /admin/:tenantId/tickets`)

Listado agregado sobre `handoff_queue` — hoy esta tabla **solo es accesible por token individual** vía `GET /asesor/:token` (`src/gateway/server.ts:99`, `src/advisor/handoffView.ts`); no existe ninguna vista que liste todos los casos escalados de un tenant a la vez. Esta fase agrega esa vista faltante, sin tocar el flujo de token existente (el asesor sigue recibiendo su enlace individual por WhatsApp, esto es solo una vista de supervisión adicional para el operador del panel).

```sql
select h.id, h.reason, h.status, h.assigned_to, h.created_at, h.resolved_at, h.summary,
       c.name as customer_name, c.phone_number
from handoff_queue h
join conversations conv on conv.id = h.conversation_id
join customers c on c.id = conv.customer_id
where h.tenant_id = $1
order by h.created_at desc;
```

`reason` toma uno de los 7 valores reales del CHECK de `migrations/0008_handoff.cjs`/`0016_escalation_reasons_fase8.cjs`: `compatibilidad_tecnica`, `monto_alto`, `solicitud_cliente`, `intentos_fallidos`, `queja`, `guardrail_precio`, `fuera_de_alcance` — se muestran tal cual, sin inventar categorías nuevas.

## Qué no cubre esta fase

- Clasificación de sentimiento ("Molestos"/"Contentos") — ver arriba.
- Resumen de lead generado por LLM — se usa heurística de último mensaje, no una llamada nueva al modelo.
- Reasignar o resolver tickets desde este listado — esas acciones ya existen en `POST /asesor/:token/tomar|resolver`; el listado de esta fase es de solo lectura/supervisión, no reemplaza el flujo del asesor.
