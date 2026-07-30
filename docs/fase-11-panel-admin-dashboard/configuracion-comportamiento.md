# Fase 11.4 — Configuración (kill-switch + modelo de IA + tono/estilo del agente)

## Tono y estilo de mensajes — ya no están bloqueados

El panel de referencia (Forja) permite editar en vivo Tono, Velocidad de respuesta y Estilo de mensajes, además del selector de Proveedor/Modelo. Esta sección documentaba originalmente por qué **Tono** quedaba fuera de esta fase: `src/orchestrator/systemPrompt.ts` es un `SYSTEM_PROMPT` fijo, y `docs/fase-4-motor-agente/prompt-caching.md` exige que sea **byte-idéntico** entre llamadas para que el prompt caching de Claude funcione — un selector de tono que interpolara texto ahí parecía invalidar el caché en cada tenant con una configuración distinta.

Esa lectura resultó más estricta de lo necesario: como ya señalaba [comparativa-arquitectura-forja.md](../comparativa-arquitectura-forja.md#qué-proponemos-como-mejora-futura-con-esfuerzo-revisado-a-la-baja-frente-a-estimaciones-previas), el requisito real de Anthropic es que cada **bloque** de `system` sea estable, no que todo el prompt sea un único string global — la API admite hasta 4 breakpoints `cache_control` independientes. **Resuelto en [ADR-021](./adrs/ADR-021-tono-personalizable-cache-jerarquico.md)**: el `SYSTEM_PROMPT` compartido se mantiene byte-idéntico como bloque 1, y un segundo bloque de tono (3 variantes fijas: Cálido/Formal/Divertido) se agrega con su propio breakpoint — probado en producción con lecturas de caché completas en el segundo call del mismo turno.

**Estilo de mensajes** (en cuántas burbujas de WhatsApp se parte la respuesta) nunca estuvo realmente bloqueado por esto — es post-procesamiento puro sobre el texto ya generado (`src/gateway/messageSplitter.ts`), no toca el prompt en absoluto. Se resolvió en el mismo incremento que Tono por compartir tabla (`tenants.behavior_config`) y sección de UI.

**Velocidad de respuesta** (debounce de mensajes seguidos) tampoco tocaba el prompt — es un mecanismo de timing sobre cuándo se dispara el turno, resuelto en [ADR-022](./adrs/ADR-022-debounce-velocidad-respuesta.md) con una cola de espera sobre Redis (Sorted Set).

**Cerebro del bot** (ruteo automático de modelo por dificultad) queda fuera de este documento — es un eje distinto (selección de modelo, no contenido del prompt) y se aborda en un incremento separado con su propia ADR.

El eje de **qué modelo procesa el prompt** (Proveedor/Modelo explícito) es distinto y **sí** entró en la Fase 11.4 original — no interpola nada dentro del `system` prompt, solo cambia qué `LLMProvider` se instancia por turno. Ver [ADR-020](./adrs/ADR-020-proveedor-modelo-configurable-byok.md) para el diseño completo.

## Kill-switch: encender/pausar el bot

**Encender/pausar el bot**, que antes de esta fase **no existía en ningún lugar del código** — no había forma de detener las respuestas automáticas de un tenant sin apagar el proceso completo (afectando a todos los tenants).

### Esquema
Migración nueva: `ALTER TABLE tenants ADD COLUMN bot_paused boolean NOT NULL DEFAULT false;` (mismo patrón incremental que `display_name` de [ADR-016](./adrs/ADR-016-parametrizacion-marca-tenant.md) — agrupar ambas columnas en la misma migración de la Fase 11 si se implementan en la misma sub-fase, o migraciones separadas si 11.1 y 11.4 se implementan en momentos distintos).

### Punto de chequeo
El chequeo va en `src/orchestrator/consumer.ts`, **antes** de invocar `loop.ts` para un mensaje entrante — no en el webhook de recepción (`src/gateway/webhookHandler.ts`), para que el mensaje del cliente se siga guardando (`messages`/`conversations` no pierden historial mientras el bot está pausado) pero no se genere ninguna respuesta automática ni se ejecute ninguna tool. Si el bot vuelve a activarse, el operador ve el mensaje pendiente en el inbox de [Conversaciones](./conversaciones-leads-tickets.md) y puede escalar manualmente a un asesor si hace falta — no hay cola de "mensajes en espera de reactivación" en esta fase.

### UI
Un toggle activo/pausado en `GET /admin/:tenantId/configuracion`, con confirmación explícita al pausar (afecta a clientes reales).

## Modelo de IA configurable (BYOK)

Segundo bloque de la misma página: selector de Proveedor (Claude/DeepSeek/ChatGPT/Grok/Gemini, más "Automático" = default de plataforma) + Modelo + API key propia opcional, con "Probar y guardar" — diseño completo, opciones consideradas y alcance excluido (ruteo automático por dificultad del mensaje) en [ADR-020](./adrs/ADR-020-proveedor-modelo-configurable-byok.md).

## Voz, estilo y velocidad del agente

Tercer bloque de la misma página: selector de Tono (Cálido/Formal/Divertido) + Estilo de mensajes (Un mensaje/2-3 cortos/Varios cortos) + Velocidad de respuesta (Inmediato/Rápido/Normal/Pausado) — diseño completo de Tono/Estilo en [ADR-021](./adrs/ADR-021-tono-personalizable-cache-jerarquico.md), de Velocidad en [ADR-022](./adrs/ADR-022-debounce-velocidad-respuesta.md). Guardado directo (`POST /admin/:tenantId/configuracion/comportamiento`), sin llamada de prueba — a diferencia del modelo de IA, acá no hay nada que validar contra una API externa.

## Qué no cubre esta fase

- Ruteo automático de modelo por dificultad/costo del mensaje ("Cerebro económico/equilibrado/máximo" como lógica dinámica, no como selector explícito) — ver ADR-020, descartado explícitamente en su momento; se reconsidera en un incremento separado con su propia ADR.
- Ninguna cola de reproceso automático de mensajes recibidos durante la pausa — se manejan manualmente desde el inbox.
