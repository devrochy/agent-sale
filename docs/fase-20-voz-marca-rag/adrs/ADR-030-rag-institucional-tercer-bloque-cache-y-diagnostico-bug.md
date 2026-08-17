# ADR-030: RAG institucional como tercer bloque de cache jerárquico, y protocolo de diagnóstico del bug de configuración

## Estado
Aceptada. El diagnóstico (sección "Diagnóstico ejecutado" abajo) se corrió antes de aceptar el resto de la ADR, tal como exigía el protocolo original — concluyó "no reproducible como bug de código"; el diseño del tercer bloque de RAG institucional queda aceptado sin cambios de alcance.

## Contexto

[ADR-021](../../fase-11-panel-admin-dashboard/adrs/ADR-021-tono-personalizable-cache-jerarquico.md) resolvió personalización de tono con dos bloques de `system prompt` y dos breakpoints `cache_control` independientes, verificado en producción contra la API real de Anthropic. La API admite hasta 4 breakpoints; ADR-021 usa 2, dejando 2 libres — su propia sección de consecuencias ya lo anota: *"quedan 2 de los 4 disponibles de Anthropic libres para uso futuro"*.

`PROPUESTA_V2.md` §3.8 pide dos cosas de naturaleza distinta que esta ADR separa explícitamente:

1. Un bloque de "Voz de Marca" + RAG institucional (misión/visión/valores) — extensión de diseño, análoga a lo que ADR-021 ya resolvió para tono.
2. Corregir "la falla reportada de que ciertos cambios de configuración no surten efecto en producción" — un reporte de bug, no una decisión de diseño. Durante la elaboración de este plan se revisó estáticamente `src/orchestrator/behaviorConfig.ts` (`resolveBehaviorConfig`) y `src/shared/db/settingsDirectory.ts`: **no se encontró ningún mecanismo de cacheo en memoria que explicara por qué un cambio no se reflejaría** — `resolveBehaviorConfig` no memoiza nada, lee el override directamente. Esto no descarta el bug; solo significa que la causa, si es real, no es evidente desde una lectura estática y requiere reproducirse con datos/logs reales.

## Opciones consideradas (para el bloque de RAG institucional)

1. **Meter voz de marca + RAG dentro del bloque de tono existente** (`toneBlocks.ts`) — descartada: mezclaría dos preocupaciones con ciclos de cambio distintos (tono cambia poco, la voz de marca/RAG institucional puede crecer con más contenido con el tiempo) bajo el mismo breakpoint, y un tenant que solo quiere tono sin RAG pagaría la invalidación de caché del bloque completo cada vez que cambie cualquiera de los dos.
2. **Tercer bloque independiente, tercer breakpoint** — elegida, mismo patrón exacto que ADR-021 ya validó para pasar de 1 a 2 bloques.

## Decisión

### Tercer bloque de `system`, tercer breakpoint

`LLMProvider.converse` (contrato `string[]`, ya neutro desde ADR-021) recibe un tercer elemento cuando el tenant tiene voz de marca/RAG configurado: `[SYSTEM_PROMPT, TONE_BLOCKS[tono], BRAND_VOICE_BLOCK(tenant)]`. `AnthropicProvider` le asigna su propio `cache_control` — tercer breakpoint de los 4 disponibles, uno queda libre para uso futuro. Proveedores sin `cache_control` explícito (`OpenAICompatibleProvider`/`GeminiProvider`) lo concatenan igual que hoy, sin cambio de comportamiento.

Nueva columna `settings.brand_voice_config jsonb` (o tabla separada si el contenido de RAG resulta extenso — texto de misión/visión/valores puede superar lo razonable para una columna jsonb simple; se decide el formato exacto al iniciar implementación, siguiendo el mismo criterio incremental que ADR-021 usó para `behavior_config`).

### Registro de Voz de Marca — texto libre, no variantes fijas

A diferencia del tono (3 variantes fijas en ADR-021, elegidas para maximizar cache-hit entre tenants), la voz de marca y el RAG institucional son **inherentemente específicos de cada negocio** (nombre, iconografía, misión/visión/valores) — no existe un conjunto fijo de variantes razonable aquí. Esto significa que el tercer breakpoint **no se comparte entre tenants** (cada tenant paga su propio costo de escritura de caché para este bloque) — mismo trade-off que ADR-021 ya identificó y descartó para tono ("texto libre... degradando a cache por tenant"), pero aceptado aquí porque la naturaleza del contenido (identidad de negocio) no admite variantes fijas sin perder el propósito de la funcionalidad.

### Protocolo de diagnóstico del bug — primero reproducir, después diseñar

Antes de dar por buena cualquier extensión de ADR-021, la Fase 20 ejecuta como primer entregable:

1. Solicitar al reporte original (Rob/negocio) el caso concreto: qué configuración se cambió, en qué pantalla, y qué comportamiento se esperaba vs. el observado.
2. Reproducir contra staging con logs de `cache_creation_input_tokens`/`cache_read_input_tokens` (mismo método de verificación que ya usó ADR-021 en producción) para confirmar si el bloque de tono realmente refleja el cambio en la siguiente llamada al LLM.
3. Si se reproduce: aislar si es (a) un problema de persistencia (el formulario del panel no graba correctamente en `settings.behavior_config`), (b) un problema de lectura (el orquestador lee un valor cacheado en algún punto no detectado en la revisión estática), o (c) confusión de UX (el cambio sí aplica, pero el panel no confirma visualmente el guardado).
4. Si no se reproduce con los pasos anteriores: documentar como "no reproducible" con la evidencia recolectada, sin dejarlo como bug abierto indefinido.

## Diagnóstico ejecutado (2026-08-05/06)

**Caso concreto reportado** (paso 1): el usuario cambió Tono y Velocidad de respuesta en `/admin/configuracion`, y no observó ningún cambio en el saludo/mensajes del bot — esperaba que el tono de la respuesta cambiara.

**Evidencia recolectada** (paso 2, contra el entorno real — proceso `node dist/src/index.js` corriendo, misma base de datos que usa el panel):

- Lectura estática confirmó, además de lo ya anotado en "Contexto", que todo el resto del camino tampoco cachea nada: `loop.ts:243` arma `[SYSTEM_PROMPT, TONE_BLOCKS[behaviorConfig.tono]]` de cero en cada turno (`processConversation` se llama una vez por turno, `behaviorConfig` no se guarda entre turnos), y `TONE_BLOCKS` (`toneBlocks.ts`) son 3 strings estáticos y distintos por tono — no hay forma de que el bloque quede "pegado" al valor anterior.
- Se probó `guardarComportamiento()` directamente contra el build en ejecución: el `UPDATE settings SET behavior_config = $1` sí persiste y `getBehaviorConfig()` lo devuelve de inmediato.
- Antes de esa prueba, `settings.behavior_config` estaba en `null` (el default) en la base real — es decir, ningún guardado previo del usuario había llegado nunca a la base de datos.
- Se le pidió al usuario reproducir el guardado desde el panel real mientras se observaba `settings.behavior_config` con polling cada 2s: el primer intento (ventana de 90s) no mostró ningún cambio — el usuario no llegó a completar la acción en esa ventana. En el segundo intento, el usuario confirmó ver el banner verde "Guardado..." y el polling capturó el cambio en el mismo instante (`tono` pasó de `"divertido"` a `"formal"` en la base, sincronizado con el clic real).

**Conclusión** (paso 4 — no reproducible como bug de código): la persistencia, lectura y armado del prompt funcionan correctamente de punta a punta contra el entorno real; quedó confirmado en vivo que un guardado exitoso desde el panel sí llega a la base de datos al instante. El estado inicial en `null` (ningún guardado previo exitoso) es la explicación más simple y consistente con todo lo observado: en el intento original del usuario el formulario no llegó a enviarse con éxito (la página de Configuración tiene varios `<form>` independientes apilados verticalmente — Modelo IA / Voz y estilo / Reporte / Reseñas / Cobros —, cada uno con su propio botón "Guardar", lo que hace fácil no notar si el clic cayó en el formulario correcto). No se encontró ningún defecto de persistencia, lectura ni caching — se documenta como "no reproducible" con la evidencia de arriba, sin dejarlo abierto. No se justifica ningún cambio de UX adicional a partir de esta sola instancia (un solo caso, ya resuelto al repetir la acción con atención al banner de confirmación); si se repite el reporte, revisar agrupar visualmente cada formulario de Configuración con su botón "Guardar" para reducir la ambigüedad.

Aparte del reporte original, en la misma sesión de reproducción el usuario reportó que el bot "no respondía" por WhatsApp — diagnosticado por separado (no relacionado con `behavior_config`): el túnel de Cloudflare (`cloudflared tunnel --url http://localhost:3000`, quick tunnel efímero) había dejado de enrutar tráfico (`curl` a la URL pública devolvía 404 de Cloudflare incluso en `/webhooks/whatsapp`, mientras que `localhost:3000/webhooks/whatsapp` respondía 403 como se espera de una firma de Twilio inválida — confirmando que el servidor sí estaba vivo). El usuario reinició el túnel y confirmó que todo corre como se esperaba.

## Consecuencias

- El diagnóstico concluyó que no había ningún bug de caching (confirmado por la revisión estática y la reproducción en vivo de la sección anterior) — esta ADR se cierra documentando la causa real encontrada (ninguna, a nivel de código), y el tercer bloque de RAG institucional se implementó sin ningún cambio adicional al patrón de ADR-021: migración `migrations/0052` (`settings.brand_voice_config jsonb`), `src/orchestrator/brandVoiceBlock.ts` (`resolveBrandVoiceConfig`/`buildBrandVoiceBlock`), integración condicional en `loop.ts` (el bloque solo se agrega al `system prompt` si el negocio configuró algo), UI de configuración y ruta de guardado en el panel (`src/admin/adminPanel.ts`, `guardarVozMarca`), con tests unitarios e de integración en verde.
- Verificación de `cache_read_input_tokens > 0` para este tercer bloque contra la API real de Anthropic (mismo criterio que documentó ADR-021 en producción) queda pendiente mientras el proyecto opera sobre DeepSeek — no bloquea el cierre de esta ADR porque el mecanismo de armado del `system prompt` es idéntico, campo por campo, al de tono ya validado.
- El tercer breakpoint deja 1 de los 4 disponibles de Anthropic libre para una futura personalización adicional.
