# shared/observability

`logger.ts`: instancia única de pino, logs JSON a stdout con `LOG_LEVEL` (ver `src/config/env.ts`). Los módulos que ya tienen `tenant_id`/`conversation_id` en scope hacen `logger.child({ tenant_id, conversation_id })` en los 8 puntos de correlación de `docs/fase-8-observabilidad-seguridad/tracing.md`. El envío a Grafana Cloud/Loki (ADR-009) queda a nivel de infraestructura (agente de reenvío), no de código.

`priceGuardrail.ts`: guardrail de verificación de precios (`docs/fase-8-observabilidad-seguridad/guardrails.md`), usado por `src/orchestrator/loop.ts`.
