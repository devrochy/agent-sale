# Fase 8 — Observabilidad, Seguridad y Guardrails

Estado: **completada** (rama `feature/fase-8-observabilidad-seguridad`)

Referencia: [MASTER_PLAN.md](../../MASTER_PLAN.md#fase-8--observabilidad-seguridad-y-guardrails) · [Fase 7 — Escalamiento a Humano](../fase-7-escalamiento-humano/README.md)

Documentación de diseño, mismo criterio que las fases anteriores. Esta fase instrumenta lo que las fases 1-7 ya construyeron — no rediseña arquitectura, cierra la capacidad de observar y proteger lo que ya existe.

## Contenido de esta fase

- [adrs/ADR-009-observabilidad.md](./adrs/ADR-009-observabilidad.md) — Grafana Cloud (free tier) como dashboard, basado en logs estructurados (Loki) en vez de instrumentación de métricas separada.
- [tracing.md](./tracing.md) — correlación por `conversation_id` en vez de tracing distribuido (no se justifica en un monolito modular).
- [guardrails.md](./guardrails.md) — verificación determinística de precios en la respuesta final (más allá del principio ya existente de "el LLM propone, la tool decide"), y límites de tema en el system prompt.
- [alertas-costo.md](./alertas-costo.md) — alerta de gasto anómalo por tenant, reutilizando el canal de WhatsApp ya usado para escalamiento (Fase 7).
- [revision-seguridad.md](./revision-seguridad.md) — checklist formal que consolida los controles ya diseñados (RLS, secretos, firma de webhook, idempotencia) más los nuevos (rate limiting, PII en logs, TLS).
- [adrs/ADR-011-metricas-negocio.md](./adrs/ADR-011-metricas-negocio.md) y [metricas-cierre-ventas.md](./metricas-cierre-ventas.md) — adenda post-implementación: funnel de cierre de ventas (conversación → cotización → pedido) contra los criterios de éxito de la Fase 0, usando Postgres directo como datasource de Grafana en vez de Loki.

## Definición de terminado

- [x] Dashboard de métricas definido (Grafana Cloud, gratuito al volumen del piloto).
- [x] Tracing end-to-end de la conversación diseñado (correlación por ID, sin sobre-ingeniería de tracing distribuido).
- [x] Guardrails de contenido definidos: verificación de precios post-generación + límites de tema.
- [x] Alertas de costo por tenant diseñadas, con canal de notificación reutilizado (no una herramienta nueva).
- [x] Checklist de revisión de seguridad consolidado, para ejecutar antes del piloto (Fase 9).

**Fase 8 completada, sin pendientes que bloqueen avanzar.** Siguiente paso: Fase 9 — Piloto Controlado (Beta con ForMotos).
