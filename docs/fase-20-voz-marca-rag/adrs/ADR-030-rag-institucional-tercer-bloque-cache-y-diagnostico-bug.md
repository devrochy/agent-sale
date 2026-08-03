# ADR-030: RAG institucional como tercer bloque de cache jerárquico, y protocolo de diagnóstico del bug de configuración

## Estado
Propuesta (pendiente de aceptación antes de iniciar implementación de la Fase 20; la sección de diagnóstico se ejecuta primero y puede cambiar el alcance de esta ADR antes de cerrarla como "Aceptada").

## Contexto

[ADR-021](../../fase-11-panel-admin-dashboard/adrs/ADR-021-tono-personalizable-cache-jerarquico.md) resolvió personalización de tono con dos bloques de `system prompt` y dos breakpoints `cache_control` independientes, verificado en producción contra la API real de Anthropic. La API admite hasta 4 breakpoints; ADR-021 usa 2, dejando 2 libres — su propia sección de consecuencias ya lo anota: *"quedan 2 de los 4 disponibles de Anthropic libres para uso futuro"*.

`PROPUESTA_V2.md` §3.8 pide dos cosas de naturaleza distinta que esta ADR separa explícitamente:

1. Un bloque de "Voz de Marca" + RAG institucional (misión/visión/valores) — extensión de diseño, análoga a lo que ADR-021 ya resolvió para tono.
2. Corregir "la falla reportada de que ciertos cambios de configuración no surten efecto en producción" — un reporte de bug, no una decisión de diseño. Durante la elaboración de este plan se revisó estáticamente `src/orchestrator/behaviorConfig.ts` (`resolveBehaviorConfig`) y `src/shared/db/tenantsDirectory.ts`: **no se encontró ningún mecanismo de cacheo en memoria que explicara por qué un cambio no se reflejaría** — `resolveBehaviorConfig` no memoiza nada, lee el override directamente. Esto no descarta el bug; solo significa que la causa, si es real, no es evidente desde una lectura estática y requiere reproducirse con datos/logs reales.

## Opciones consideradas (para el bloque de RAG institucional)

1. **Meter voz de marca + RAG dentro del bloque de tono existente** (`toneBlocks.ts`) — descartada: mezclaría dos preocupaciones con ciclos de cambio distintos (tono cambia poco, la voz de marca/RAG institucional puede crecer con más contenido con el tiempo) bajo el mismo breakpoint, y un tenant que solo quiere tono sin RAG pagaría la invalidación de caché del bloque completo cada vez que cambie cualquiera de los dos.
2. **Tercer bloque independiente, tercer breakpoint** — elegida, mismo patrón exacto que ADR-021 ya validó para pasar de 1 a 2 bloques.

## Decisión

### Tercer bloque de `system`, tercer breakpoint

`LLMProvider.converse` (contrato `string[]`, ya neutro desde ADR-021) recibe un tercer elemento cuando el tenant tiene voz de marca/RAG configurado: `[SYSTEM_PROMPT, TONE_BLOCKS[tono], BRAND_VOICE_BLOCK(tenant)]`. `AnthropicProvider` le asigna su propio `cache_control` — tercer breakpoint de los 4 disponibles, uno queda libre para uso futuro. Proveedores sin `cache_control` explícito (`OpenAICompatibleProvider`/`GeminiProvider`) lo concatenan igual que hoy, sin cambio de comportamiento.

Nueva columna `tenants.brand_voice_config jsonb` (o tabla separada si el contenido de RAG resulta extenso — texto de misión/visión/valores puede superar lo razonable para una columna jsonb simple; se decide el formato exacto al iniciar implementación, siguiendo el mismo criterio incremental que ADR-021 usó para `behavior_config`).

### Registro de Voz de Marca — texto libre, no variantes fijas

A diferencia del tono (3 variantes fijas en ADR-021, elegidas para maximizar cache-hit entre tenants), la voz de marca y el RAG institucional son **inherentemente específicos de cada negocio** (nombre, iconografía, misión/visión/valores) — no existe un conjunto fijo de variantes razonable aquí. Esto significa que el tercer breakpoint **no se comparte entre tenants** (cada tenant paga su propio costo de escritura de caché para este bloque) — mismo trade-off que ADR-021 ya identificó y descartó para tono ("texto libre... degradando a cache por tenant"), pero aceptado aquí porque la naturaleza del contenido (identidad de negocio) no admite variantes fijas sin perder el propósito de la funcionalidad.

### Protocolo de diagnóstico del bug — primero reproducir, después diseñar

Antes de dar por buena cualquier extensión de ADR-021, la Fase 20 ejecuta como primer entregable:

1. Solicitar al reporte original (Rob/negocio) el caso concreto: qué configuración se cambió, en qué pantalla, y qué comportamiento se esperaba vs. el observado.
2. Reproducir contra staging con logs de `cache_creation_input_tokens`/`cache_read_input_tokens` (mismo método de verificación que ya usó ADR-021 en producción) para confirmar si el bloque de tono realmente refleja el cambio en la siguiente llamada al LLM.
3. Si se reproduce: aislar si es (a) un problema de persistencia (el formulario del panel no graba correctamente en `tenants.behavior_config`), (b) un problema de lectura (el orquestador lee un valor cacheado en algún punto no detectado en la revisión estática), o (c) confusión de UX (el cambio sí aplica, pero el panel no confirma visualmente el guardado).
4. Si no se reproduce con los pasos anteriores: documentar como "no reproducible" con la evidencia recolectada, sin dejarlo como bug abierto indefinido.

## Consecuencias

- El diagnóstico puede concluir que no hay ningún bug de caching (lo más probable según la revisión estática ya hecha) — en ese caso esta ADR se cierra documentando la causa real encontrada (o su ausencia), y el tercer bloque de RAG se implementa sin ningún cambio adicional al patrón de ADR-021.
- Si el diagnóstico encuentra una causa real distinta al caching, la corrección correspondiente queda fuera del alcance de "diseño de RAG institucional" y se trata como fix independiente, documentado en esta misma ADR para trazabilidad.
- El tercer breakpoint deja 1 de los 4 disponibles de Anthropic libre para una futura personalización adicional.
