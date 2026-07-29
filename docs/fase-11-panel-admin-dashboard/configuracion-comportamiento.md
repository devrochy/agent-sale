# Fase 11.4 — Configuración (alcance reducido: kill-switch)

## Por qué el alcance se reduce frente al panel de referencia

El panel de referencia permite editar en vivo Tono, Velocidad de respuesta, Estilo de mensajes y "Cerebro del bot" (económico/equilibrado/máximo). En agent-sale eso chocaría directamente con una decisión ya tomada: `src/orchestrator/systemPrompt.ts` es un `SYSTEM_PROMPT` fijo, y `docs/fase-4-motor-agente/prompt-caching.md` exige que sea **byte-idéntico** entre llamadas para que el prompt caching de Claude funcione — el propio documento dice explícitamente "no interpolar fecha/hora, IDs de sesión, ni ningún valor variable dentro del texto del system prompt". Un selector de tono que interpole texto ahí invalida el caché en cada tenant con una configuración distinta, con impacto directo en costo (el mismo costo que [ADR-017](./adrs/ADR-017-persistencia-uso-llm-postgres.md) busca poder medir).

Resolver esto bien requiere una ADR propia sobre cómo parametrizar el prompt por tenant sin perder el caching (ej. separar un bloque de instrucciones de tono en `messages` en vez de `system`, o aceptar el costo de no cachear para tenants con personalización) — **no se resuelve en esta fase**, se documenta como pendiente futuro explícito.

**Pista para esa ADR futura, no resuelta aquí:** [comparativa-arquitectura-forja.md](../comparativa-arquitectura-forja.md#qué-proponemos-como-mejora-futura-con-esfuerzo-revisado-a-la-baja-frente-a-estimaciones-previas) señala que el bloqueo asumido ("byte-idéntico entre **todos** los tenants") podría ser más estricto de lo que el prompt caching de Claude realmente exige (estabilidad **por tenant**, no necesariamente un único string global) — vale la pena validarlo con datos reales antes de descartar la personalización de tono por completo.

## Lo único que se construye en esta fase: kill-switch

Único control de "Configuración" que no toca el prompt: **encender/pausar el bot**, que hoy **no existe en ningún lugar del código** — no hay forma actual de detener las respuestas automáticas de un tenant sin apagar el proceso completo (afectando a todos los tenants).

### Esquema
Migración nueva: `ALTER TABLE tenants ADD COLUMN bot_paused boolean NOT NULL DEFAULT false;` (mismo patrón incremental que `display_name` de [ADR-016](./adrs/ADR-016-parametrizacion-marca-tenant.md) — agrupar ambas columnas en la misma migración de la Fase 11 si se implementan en la misma sub-fase, o migraciones separadas si 11.1 y 11.4 se implementan en momentos distintos).

### Punto de chequeo
El chequeo va en `src/orchestrator/consumer.ts`, **antes** de invocar `loop.ts` para un mensaje entrante — no en el webhook de recepción (`src/gateway/webhookHandler.ts`), para que el mensaje del cliente se siga guardando (`messages`/`conversations` no pierden historial mientras el bot está pausado) pero no se genere ninguna respuesta automática ni se ejecute ninguna tool. Si el bot vuelve a activarse, el operador ve el mensaje pendiente en el inbox de [Conversaciones](./conversaciones-leads-tickets.md) y puede escalar manualmente a un asesor si hace falta — no hay cola de "mensajes en espera de reactivación" en esta fase.

### UI
Un único toggle en `GET /admin/:tenantId/configuracion`, con confirmación explícita al pausar (afecta a clientes reales) — sin las demás cards (tono/velocidad/estilo/cerebro) del panel de referencia.

## Qué no cubre esta fase

- Tono, velocidad de respuesta, estilo de mensajes, "cerebro económico/equilibrado/máximo" — requieren la ADR de parametrización de prompt mencionada arriba, no incluida en la Fase 11.
- Ninguna cola de reproceso automático de mensajes recibidos durante la pausa — se manejan manualmente desde el inbox.
