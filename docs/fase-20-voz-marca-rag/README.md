# Fase 20 — Personalización del Asistente: Voz de Marca, RAG Institucional y Diagnóstico de Configuración

Estado: **en diseño** (v2)

Referencia: [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md#fase-20--personalización-del-asistente-voz-de-marca-rag-institucional-y-diagnóstico-de-configuración) · [PROPUESTA_V2.md §3.8](../../PROPUESTA_V2.md) · [ADR-021 — Tono personalizable con cache jerárquico](../fase-11-panel-admin-dashboard/adrs/ADR-021-tono-personalizable-cache-jerarquico.md) · [Fase 11.4 — Configuración](../fase-11-panel-admin-dashboard/configuracion-comportamiento.md)

Extiende el mecanismo de cache jerárquico de ADR-021 con un tercer bloque de `system prompt` (voz de marca + RAG institucional), investiga qué más es razonable hacer configurable en un asistente de ventas con IA, y **reproduce primero, no asume**, el bug reportado de configuraciones que no surten efecto en producción.

## Relación con v1 — corrección de premisa importante

`PROPUESTA_V2.md` §3.8 pide diseñar esto "en conjunto con ADR-021... para no reabrir el problema de prompt caching que esa ADR ya cerró", como si el tono todavía estuviera en diseño. **Verificado contra `git log` y el código real** (ver "Estado real verificado" en `MASTER_PLAN_V2.md`): ADR-021 no solo está aceptada, está **implementada, mergeada y con verificación de cache-hit en producción documentada en la propia ADR** (`cache_read_input_tokens: 4341` en la segunda llamada del turno). Esta fase por lo tanto no reabre un diseño pendiente — **extiende un mecanismo ya operando**, agregando un tercer bloque/breakpoint siguiendo exactamente el mismo patrón que el segundo bloque (tono) ya validó.

## Contenido de esta fase

- [adrs/ADR-030-rag-institucional-tercer-bloque-cache-y-diagnostico-bug.md](./adrs/ADR-030-rag-institucional-tercer-bloque-cache-y-diagnostico-bug.md) — diseño del tercer bloque de `system prompt`, y el protocolo de diagnóstico del bug reportado (no se asume causa antes de reproducirlo).

## Dependencias

Ninguna estructural de v2.

## Riesgos

- Un bloque de RAG institucional (misión/visión/valores) es más largo que el bloque de tono actual — riesgo ya documentado en ADR-021 de quedar por debajo del mínimo cacheable en algunos modelos; si ocurre, no rompe nada, solo no ahorra costo (mismo comportamiento ya validado).
- El ahorro de cache jerárquico de 3 bloques solo aplica completo con Anthropic como proveedor activo — mientras el proyecto opere sobre DeepSeek (ver pendiente #4 de `pendientes-pre-piloto.md`, Fase 9), esta fase es funcional pero sin el ahorro de costo pleno, debe comunicarse así a negocio.

## Definición de terminado

- [ ] Causa raíz del bug de configuración identificada y corregida, o descartada como no reproducible con evidencia — documentada en la ADR antes de dar la fase por cerrada.
- [ ] Un tenant con RAG institucional configurado responde consistentemente con su misión/valores, verificado con cache-read en la segunda llamada del turno (mismo criterio de verificación que ADR-021).
- [ ] Documento de investigación de variables configurables adicionales entregado con recomendación priorizada, sin implementación total comprometida de antemano.

Puede ejecutarse en paralelo con las Fases 14-19.
