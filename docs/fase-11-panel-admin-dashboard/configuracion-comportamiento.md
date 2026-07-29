# Fase 11.4 — Configuración (kill-switch + modelo de IA configurable)

## Por qué el tono/estilo de redacción sigue fuera de alcance

El panel de referencia (Forja) permite editar en vivo Tono, Velocidad de respuesta y Estilo de mensajes, además del selector de Proveedor/Modelo. En agent-sale, el eje de **tono/estilo** (qué dice el prompt) sigue chocando con una decisión ya tomada: `src/orchestrator/systemPrompt.ts` es un `SYSTEM_PROMPT` fijo, y `docs/fase-4-motor-agente/prompt-caching.md` exige que sea **byte-idéntico** entre llamadas para que el prompt caching de Claude funcione — el propio documento dice explícitamente "no interpolar fecha/hora, IDs de sesión, ni ningún valor variable dentro del texto del system prompt". Un selector de tono que interpole texto ahí invalida el caché en cada tenant con una configuración distinta, con impacto directo en costo.

Resolver esto bien requiere una ADR propia sobre cómo parametrizar el prompt por tenant sin perder el caching (ej. separar un bloque de instrucciones de tono en `messages` en vez de `system`, o aceptar el costo de no cachear para tenants con personalización) — **no se resuelve en esta fase**, se documenta como pendiente futuro explícito.

**Pista para esa ADR futura, no resuelta aquí:** [comparativa-arquitectura-forja.md](../comparativa-arquitectura-forja.md#qué-proponemos-como-mejora-futura-con-esfuerzo-revisado-a-la-baja-frente-a-estimaciones-previas) señala que el bloqueo asumido ("byte-idéntico entre **todos** los tenants") podría ser más estricto de lo que el prompt caching de Claude realmente exige (estabilidad **por tenant**, no necesariamente un único string global) — vale la pena validarlo con datos reales antes de descartar la personalización de tono por completo.

El eje de **qué modelo procesa el prompt** (Proveedor/Modelo/"Cerebro económico vs. máximo") es distinto y **sí** entra en esta fase — no interpola nada dentro del `system` prompt, solo cambia qué `LLMProvider` se instancia por turno. Ver [ADR-020](./adrs/ADR-020-proveedor-modelo-configurable-byok.md) para el diseño completo.

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

## Qué no cubre esta fase

- Tono, velocidad de respuesta, estilo de mensajes de redacción — requieren la ADR de parametrización de prompt mencionada arriba, no incluida en la Fase 11.
- Ruteo automático de modelo por dificultad/costo del mensaje ("Cerebro económico/equilibrado/máximo" como lógica dinámica, no como selector explícito) — ver ADR-020, descartado explícitamente para esta fase.
- Ninguna cola de reproceso automático de mensajes recibidos durante la pausa — se manejan manualmente desde el inbox.
