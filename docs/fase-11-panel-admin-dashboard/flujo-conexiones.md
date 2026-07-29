# Fase 11.3 — Flujo del agente + Conexiones

Depende menos de datos transaccionales que 11.1/11.2 y más de introspección de configuración/logs — se ubica después porque tiene menor prioridad de negocio directa que Leads/Tickets, aunque es independiente en términos de datos.

## Flujo (`GET /admin/:tenantId/flujo`)

El panel de referencia muestra un diagrama en vivo con nodos genéricos de canal/buffer/agente/tools/memoria. Esta fase construye el equivalente **con los nodos reales de agent-sale**, no una copia de los nombres del panel de referencia — el orquestador de este proyecto no tiene "Buffer" ni las tools `searchKb`/`pauseBot`/`snoozeUser` que aparecían ahí (esas no existen en `toolExecutor.ts`).

Diagrama estático (no editable, mismo criterio que el panel de referencia: "es una radiografía honesta, no un editor"):

```
Canal (WhatsApp/Twilio) → Orquestador (src/orchestrator/loop.ts)
                              ├─ Modelo: env.LLM_PROVIDER (anthropic | openai_compatible), env.LLM_MODEL
                              ├─ Memoria: conversations.state (jsonb) + historial de messages
                              └─ Tools:
                                   consultar_inventario
                                   generar_cotizacion
                                   aplicar_promocion
                                   crear_pedido
                                   recomendar_producto
                                   escalar_a_humano
                            → Respuesta (outbound vía Twilio)
```

**Contadores por tool (últimos 30 días)** — no requiere ninguna tabla nueva ni tocar Loki: se derivan de `messages.tool_calls` (jsonb con los bloques `ContentBlock` del mensaje `assistant`, incluye `tool_use` con `name` — ver `src/orchestrator/memory.ts:92`), con la misma fuente que ya usa el detalle de conversación de la [Fase 11.2](./conversaciones-leads-tickets.md#conversaciones-get-admintenantidconversaciones):

```sql
select block ->> 'name' as tool, count(*) as llamadas_30d
from messages m,
     jsonb_array_elements(m.tool_calls) as block
where m.tenant_id = $1
  and m.tool_calls is not null
  and block ->> 'type' = 'tool_use'
  and m.created_at >= now() - interval '30 days'
group by 1
order by 2 desc;
```

Selector de canal ("viendo el flujo de: canal X") del panel de referencia **no aplica todavía**: hoy solo existe un canal (WhatsApp/Twilio, ver Conexiones abajo) — el selector se agrega cuando exista un segundo canal real, no antes.

## Conexiones (`GET /admin/:tenantId/conexiones`)

El panel de referencia muestra 6 tarjetas de canal (sitio web, Telegram, WhatsApp Twilio, WhatsApp Cloud API/Meta, Instagram+Messenger, ManyChat). **Agent-sale integra un solo canal real hoy: WhatsApp vía Twilio** (`src/config/env.ts`: `TWILIO_AUTH_TOKEN`, `TWILIO_ACCOUNT_SID`, `TWILIO_WHATSAPP_NUMBER`, `PUBLIC_WEBHOOK_URL`; webhook verificado en `src/gateway/twilioSignature.ts`). No existen `TELEGRAM_*`, `META_*`, ni ninguna otra variable de canal en el proyecto — construir tarjetas para esos canales sería mostrar una capacidad que no existe, lo mismo que se evita en el resto de esta fase.

Esta fase agrega **una sola tarjeta real** (WhatsApp/Twilio), con el mismo patrón útil del panel de referencia:

- Estado: conectado si `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_WHATSAPP_NUMBER` están presentes en `env`, sin conectar si falta alguna.
- URL de webhook a configurar en Twilio: `${env.PUBLIC_WEBHOOK_URL}/webhooks/whatsapp`, con botón de copiar (interacción Alpine.js pura, sin request).
- Instrucciones inline de qué variable falta si el estado es "sin conectar" (mismo texto explicativo que el panel de referencia usa, adaptado a las variables reales del proyecto).

El diseño de la tarjeta se deja extensible (una lista de canales soportados con su propio bloque de variables/estado) para que agregar un canal nuevo en el futuro (ej. Telegram, si algún día se implementa) sea agregar una entrada a esa lista, no rediseñar la página — pero no se construyen tarjetas para canales que hoy no tienen ninguna integración detrás.

## Qué no cubre esta fase

- **Conocimiento** (subir/reindexar documentos): no existe el subsistema base (no hay tabla de documentos, no hay chunking, no hay tool de retrieval — el único uso de `embedding`/pgvector en el proyecto es sobre `products`, para `recomendar_producto`, no sobre documentos). Se excluye explícitamente de toda la Fase 11, no solo de esta sub-fase — ver [mapeo-funcionalidades.md](./mapeo-funcionalidades.md). Construirlo es un dominio nuevo completo, candidato a fase propia si se decide priorizarlo.
- **Mejoras** (detección automática de huecos de conocimiento): depende de Conocimiento, mismo motivo de exclusión.
- Tarjetas de canales no integrados (Telegram, Instagram, ManyChat, sitio web con widget) — ver arriba.
