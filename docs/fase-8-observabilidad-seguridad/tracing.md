# Tracing End-to-End de la Conversación

## Decisión: correlación por `conversation_id`, no tracing distribuido

El sistema es un **monolito modular** (decisión de la Fase 2, no microservicios). Adoptar tracing distribuido completo (spans, OpenTelemetry, propagación de contexto entre servicios) resuelve un problema — correlacionar llamadas entre servicios independientes — que este proyecto no tiene todavía, porque todo corre en el mismo proceso. Instrumentar eso ahora sería complejidad sin beneficio real (mismo criterio aplicado en toda la arquitectura: no diseñar para hipotéticos).

En su lugar: **cada línea de log que el sistema emite durante el procesamiento de un mensaje incluye `conversation_id`** (y `tenant_id`) como campo estructurado. Esto es suficiente para reconstruir el flujo completo de una conversación — desde que el webhook la recibe hasta que la respuesta sale por Twilio — usando una simple consulta LogQL en Grafana Cloud ([ADR-009](./adrs/ADR-009-observabilidad.md)) filtrando por ese ID.

## Qué queda trazado, en orden

```
1. gateway: mensaje recibido (conversation_id, message_sid, tenant_id)
2. gateway: encolado en Redis Streams
3. orchestrator: mensaje tomado de la cola (latencia de cola = paso 3 - paso 2)
4. orchestrator: llamada a Claude iniciada
5. orchestrator: llamada a Claude completada (latencia, tokens, cache_read/cache_creation — ver Fase 4)
6. [por cada tool ejecutada]: tool iniciada → tool completada (latencia individual)
7. orchestrator: respuesta lista, enviada a Twilio
8. gateway: confirmación de envío de Twilio
```

Con estos 8 puntos correlacionados por `conversation_id`, es posible responder preguntas operativas reales: "¿por qué esta conversación tardó 12 segundos en responder?" (¿fue la cola, Claude, o una tool lenta?), sin necesitar spans distribuidos.

## Métrica derivada: latencia total por turno

Se calcula como la diferencia entre el timestamp del paso 1 (mensaje recibido) y el paso 8 (confirmación de envío) — esta es la métrica de "tiempo de respuesta" que la Fase 0 fijó como criterio de éxito (`< 30 segundos`). Se agrega en el dashboard de Grafana Cloud como percentil (p50/p95), no solo promedio, porque un promedio esconde los casos lentos que más le importan al negocio.

## Qué no cubre este documento
- Instrumentación real (código, formato exacto de los logs) — fuera del alcance de este plan de arquitectura.
- Tracing distribuido — descartado deliberadamente para el tamaño actual del sistema, ver arriba. Se revisita solo si el monolito se llega a partir en servicios separados (Fase 10, condicional).
