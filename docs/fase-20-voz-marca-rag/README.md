# Fase 20 — Personalización del Asistente: Voz de Marca, RAG Institucional y Diagnóstico de Configuración

Estado: **completa** (v2) — pendiente solo commit/PR, y verificación de `cache_read_input_tokens` del tercer bloque contra Anthropic real cuando el proyecto deje de operar sobre DeepSeek.

Referencia: [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md#fase-20--personalización-del-asistente-voz-de-marca-rag-institucional-y-diagnóstico-de-configuración) · [PROPUESTA_V2.md §3.8](../../PROPUESTA_V2.md) · [ADR-021 — Tono personalizable con cache jerárquico](../fase-11-panel-admin-dashboard/adrs/ADR-021-tono-personalizable-cache-jerarquico.md) · [Fase 11.4 — Configuración](../fase-11-panel-admin-dashboard/configuracion-comportamiento.md)

Extiende el mecanismo de cache jerárquico de ADR-021 con un tercer bloque de `system prompt` (voz de marca + RAG institucional), investiga qué más es razonable hacer configurable en un asistente de ventas con IA, y **reproduce primero, no asume**, el bug reportado de configuraciones que no surten efecto en producción.

## Relación con v1 — corrección de premisa importante

`PROPUESTA_V2.md` §3.8 pide diseñar esto "en conjunto con ADR-021... para no reabrir el problema de prompt caching que esa ADR ya cerró", como si el tono todavía estuviera en diseño. **Verificado contra `git log` y el código real** (ver "Estado real verificado" en `MASTER_PLAN_V2.md`): ADR-021 no solo está aceptada, está **implementada, mergeada y con verificación de cache-hit en producción documentada en la propia ADR** (`cache_read_input_tokens: 4341` en la segunda llamada del turno). Esta fase por lo tanto no reabre un diseño pendiente — **extiende un mecanismo ya operando**, agregando un tercer bloque/breakpoint siguiendo exactamente el mismo patrón que el segundo bloque (tono) ya validó.

## Contenido de esta fase

- [adrs/ADR-030-rag-institucional-tercer-bloque-cache-y-diagnostico-bug.md](./adrs/ADR-030-rag-institucional-tercer-bloque-cache-y-diagnostico-bug.md) — diseño del tercer bloque de `system prompt`, y el protocolo de diagnóstico del bug reportado (no se asume causa antes de reproducirlo).
- [investigacion-variables-configurables.md](./investigacion-variables-configurables.md) — investigación de qué más es razonable hacer configurable, con recomendación priorizada.

## Dependencias

Ninguna estructural de v2.

## Riesgos

- Un bloque de RAG institucional (misión/visión/valores) es más largo que el bloque de tono actual — riesgo ya documentado en ADR-021 de quedar por debajo del mínimo cacheable en algunos modelos; si ocurre, no rompe nada, solo no ahorra costo (mismo comportamiento ya validado).
- El ahorro de cache jerárquico de 3 bloques solo aplica completo con Anthropic como proveedor activo — mientras el proyecto opere sobre DeepSeek (ver pendiente #4 de `pendientes-pre-piloto.md`, Fase 9), esta fase es funcional pero sin el ahorro de costo pleno, debe comunicarse así a negocio.

## Definición de terminado

- [x] Causa raíz del bug de configuración identificada y corregida, o descartada como no reproducible con evidencia — documentada en la ADR antes de dar la fase por cerrada. Descartada como no reproducible (ver ADR-030, sección "Diagnóstico ejecutado"): persistencia, lectura y armado del prompt verificados correctos de punta a punta contra el entorno real.
- [x] Tercer bloque de `system prompt` (voz de marca + RAG institucional) implementado siguiendo exactamente el patrón de ADR-021: `migrations/0052` (`settings.brand_voice_config`), `src/orchestrator/brandVoiceBlock.ts`, integración condicional en `loop.ts` (solo se agrega si hay algo configurado), UI de configuración y ruta de guardado en el panel, tests unitarios e de integración en verde. **Pendiente de este ítem**: la verificación de `cache_read_input_tokens > 0` en la segunda llamada del turno (mismo criterio que documentó ADR-021) requiere Anthropic como proveedor activo — mientras el proyecto opera sobre DeepSeek (ver pendiente #4 de `pendientes-pre-piloto.md`, Fase 9), esa verificación de ahorro de cache no puede correrse contra un modelo real; el mecanismo en código es idéntico al de tono (ya validado), así que se acepta como completo a nivel de implementación y se deja pendiente solo la verificación de costo cuando el proyecto vuelva a Anthropic.
- [x] Documento de investigación de variables configurables adicionales entregado con recomendación priorizada, sin implementación total comprometida de antemano — ver [investigacion-variables-configurables.md](./investigacion-variables-configurables.md).

Puede ejecutarse en paralelo con las Fases 14-19.
