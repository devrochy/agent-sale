# ADR-021: Tono personalizable por tenant con cache jerárquico

## Estado

Aceptado.

## Contexto

Al parametrizar el resto de la sección "Configuración" del panel de referencia Forja (`/admin/config` — Tono, Velocidad de respuesta, Estilo de mensajes, Cerebro del bot), el usuario pidió explícitamente personalizar el **Tono** de voz del agente (Cálido/Formal/Divertido) por tenant.

Esto chocaba con una decisión ya tomada: [`docs/fase-4-motor-agente/prompt-caching.md`](../../fase-4-motor-agente/prompt-caching.md) exige que el `SYSTEM_PROMPT` sea **byte-idéntico** entre llamadas para que el prompt caching de Claude funcione, y [`configuracion-comportamiento.md`](../configuracion-comportamiento.md) (Fase 11.4) excluyó explícitamente personalizar tono por esto — "un selector de tono que interpole texto ahí invalida el caché en cada tenant con una configuración distinta". [`docs/comparativa-arquitectura-forja.md`](../../comparativa-arquitectura-forja.md) ya había propuesto (sin resolver) revisar este bloqueo con un diseño de "prompt base compartido + bloque de personalización por tenant, cacheado con una clave de `cache_control` distinta".

Se confirmó el mecanismo real de prompt caching de Claude contra la documentación oficial (skill `claude-api`, `shared/prompt-caching.md`): la API permite hasta 4 breakpoints `cache_control` por request, y cada uno es un checkpoint de **prefijo independiente** — invalidar un breakpoint no invalida los anteriores. El patrón "shared prefix, varying suffix" documentado ahí (breakpoint al final de la porción compartida, contenido variable después) es exactamente lo que hace falta para personalizar tono sin perder el caching del resto del prompt.

## Opciones consideradas

- **No personalizar tono, mantener el bloqueo de la Fase 11.4**: descartado — el usuario lo pidió explícitamente, y la investigación mostró que el bloqueo original partía de un supuesto ("byte-idéntico entre _todos_ los tenants") más estricto de lo que la API realmente exige.
- **Texto libre por tenant** (el tenant escribe su propia descripción de tono): más flexible, pero cada tenant tendría un bloque de `system` distinto — el segundo breakpoint nunca se reutilizaría entre tenants, degradando a "cache por tenant" en el peor sentido (cada tenant paga su propio costo de escritura sin compartir nada). Descartado por ahora a favor de variantes fijas; texto libre queda como posible iteración futura si se justifica con datos reales de uso.
- **3 variantes fijas** (Cálido/Formal/Divertido, igual que el selector de Forja), elegida: dos tenants que eligen el mismo tono comparten el mismo bloque byte a byte — el segundo breakpoint se lee entre tenants, no solo dentro de uno. El cache-hit rate se mantiene alto en toda la plataforma en vez de fragmentarse por tenant.

## Decisión

### Dos bloques de `system`, dos breakpoints de `cache_control`

`src/orchestrator/systemPrompt.ts` queda como el **bloque compartido** (reglas de negocio, formato de WhatsApp, escalamiento — nada de esto es tono, byte-idéntico para todos los tenants, igual que antes). Se sacaron de ahí las únicas líneas realmente tone-specific (la frase de tono + la sección "Ejemplos de tono") hacia `src/orchestrator/toneBlocks.ts`: `TONE_BLOCKS: Record<"calido"|"formal"|"divertido", string>`, 3 variantes fijas con instrucción de voz + los 3 mismos ejemplos de diálogo reescritos en cada registro. La variante `"calido"` es el texto que ya vivía en `SYSTEM_PROMPT` (sin reescribir) — es el default para cualquier tenant sin `behavior_config.tono` configurado, cero regresión de comportamiento.

Nueva columna `tenants.behavior_config jsonb` (migración `0021_tenants_behavior_config.cjs`, mismo patrón que `escalation_config`): `NULL` = usar los defaults in-code de `src/orchestrator/behaviorConfig.ts` (`resolveBehaviorConfig`, mismo criterio que `resolveEscalationConfig` — merge campo por campo, sin deep merge).

### Contrato neutro: `systemPrompt: string` → `string[]`

`LLMProvider.converse` (`src/orchestrator/llm/types.ts`) pasa a recibir un **array** de bloques de texto plano — sin metadata de cache, eso es Anthropic-específico y no pertenece al contrato neutro (ver ADR-010). `AnthropicProvider` mapea cada elemento del array a su propio `{type:"text", text, cache_control:{type:"ephemeral"}}` — dos breakpoints en total (bloque compartido, bloque de tono), quedan 2 de los 4 disponibles de Anthropic libres para uso futuro. `OpenAICompatibleProvider`/`GeminiProvider` simplemente concatenan el array con `.join("\n\n")` — cero cambio de comportamiento ahí, ninguno de los dos tiene un equivalente a `cache_control` explícito (su caching ya es opaco/automático, ver ADR-010).

`loop.ts` resuelve `behaviorConfig` una vez por turno (mismo momento que resuelve `llmProvider`, ver ADR-020) y arma `[SYSTEM_PROMPT, TONE_BLOCKS[behaviorConfig.tono]]`.

## Verificación en producción

Se probó en vivo contra la API real de Anthropic (Claude Sonnet 5): la primera llamada del turno (antes de resolver una tool) mostró `cache_creation_input_tokens: 4341, cache_read_input_tokens: 0` (primera vez que se ve esa combinación exacta de bloques); la segunda llamada del mismo turno (tras el `tool_result`) mostró `cache_read_input_tokens: 4341, cache_creation_input_tokens: 0` — lectura completa desde caché. Confirma que el mecanismo de 2 breakpoints funciona end-to-end, no solo en la documentación de la API.

## Consecuencias

- No revierte `prompt-caching.md` — lo extiende: ya no es "un solo bloque estático", son 2 breakpoints jerárquicos, documentado ahí mismo.
- **Riesgo documentado, no bloqueante**: el bloque de tono es bastante más chico que el compartido — en teoría podría quedar por debajo del mínimo de tokens cacheables de un modelo dado (varía por modelo, ver `prompt-caching.md` de la skill `claude-api`). Si eso pasara, el segundo breakpoint no ahorraría costo pero tampoco rompería nada (el LLM igual recibe el texto completo) — la prueba en producción de arriba confirma que con Sonnet 5 esto no es un problema real hoy.
- Un tenant que cambia de proveedor sigue beneficiándose de este diseño solo si el proveedor activo es Anthropic — para DeepSeek/OpenAI/Grok/Gemini, el tono igual se aplica (el LLM recibe el texto completo vía `.join`), solo que sin el ahorro de cache explícito (su caching, cuando existe, ya es automático y opaco).
- El resto de la sección "Configuración" de Forja (Velocidad de respuesta, Estilo de mensajes, Cerebro del bot) se resuelve en incrementos separados — Estilo de mensajes es post-procesamiento puro (no toca el prompt, no requiere esta ADR), Velocidad y Cerebro tienen sus propias ADRs (022 y 023).
