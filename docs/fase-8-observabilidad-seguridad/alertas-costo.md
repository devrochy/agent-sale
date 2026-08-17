# Alertas de Costo por Tenant

## Por qué
El proyecto completo está optimizado para bajo costo (BSP, hosting, base de datos, modelo — ver ADRs de fases anteriores), pero ningún control de costo evita que un caso anómalo (un bucle de tool calling mal comportado, un cliente enviando mensajes repetidos, o simplemente más tráfico del esperado) dispare el gasto sin que nadie se entere hasta la factura mensual. Esta fase agrega la alerta que falta: detectar el gasto anómalo **mientras ocurre**, no después.

## Qué se mide

Cada llamada a Claude ya registra `usage` (tokens de entrada/salida, `cache_read_input_tokens`, `cache_creation_input_tokens` — ver [prompt-caching.md](../fase-4-motor-agente/prompt-caching.md), Fase 4) como parte del log estructurado ([tracing.md](./tracing.md)). A partir de esos logs, se agrega en Grafana Cloud ([ADR-009](./adrs/ADR-009-observabilidad.md)) el costo estimado por tenant, por día — convirtiendo tokens a costo según el pricing de Sonnet 5 ya usado en la estimación de la Fase 4.

## Umbral de alerta

Se dispara una alerta si el costo estimado de un tenant en un día supera, por ejemplo, **3× el promedio diario esperado** (según la estimación de ~$12 USD/mes de la Fase 4, un día normal para ForMotos ronda los $0,40 USD — el umbral de alerta sería ~$1,20 USD/día). El múltiplo exacto es configurable, no un valor fijo — se afina con datos reales del piloto (Fase 9).

## Canal de la alerta

**Se reutiliza el mismo canal de notificación por WhatsApp ya definido para el escalamiento** ([handoff-queue.md](../fase-7-escalamiento-humano/handoff-queue.md), Fase 7), esta vez dirigido al responsable técnico del proyecto (no al asesor comercial de ForMotos) — evita agregar un canal de alertas nuevo (email, Slack, PagerDuty) solo para este caso, consistente con el patrón ya establecido de reutilizar infraestructura existente en vez de sumar herramientas.

Alternativa técnica: Grafana Cloud free tier incluye alerting propio, que también podría enviar directamente a WhatsApp o email sin pasar por la lógica de la aplicación — la decisión entre "alerta desde Grafana" y "alerta desde la aplicación" es un detalle de implementación, no de arquitectura; ambas cumplen el mismo objetivo de no dejar el costo anómalo sin detectar.

## Qué pasa cuando se dispara

La alerta es informativa, no automática — no se corta el servicio al tenant ni se bloquea la conversación en curso. Frenar automáticamente el agente de un negocio real por una alerta de costo sería un riesgo de negocio mayor que el propio costo anómalo (dejar a un cliente de ForMotos sin respuesta). La alerta le da al responsable técnico la oportunidad de investigar (¿es tráfico legítimo que creció, o un bug?) y actuar manualmente si hace falta.

## Qué no cubre este documento
- Implementación real de la agregación de costo (código, consulta LogQL exacta) — fuera del alcance de este plan de arquitectura.
- El múltiplo exacto del umbral — propuesta inicial, a afinar con datos reales del piloto.
