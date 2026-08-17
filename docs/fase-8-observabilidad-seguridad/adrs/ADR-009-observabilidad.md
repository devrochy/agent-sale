# ADR-009: Herramienta de observabilidad (dashboard de métricas)

## Estado
Aceptado.

## Contexto
El `MASTER_PLAN.md` pide un dashboard de métricas (latencia, tasa de escalamiento, tokens/costo por tenant). Ni Fly.io (ADR-005) ni Supabase (ADR-006) dan por sí solos un dashboard de métricas *de negocio* — dan métricas de infraestructura (CPU, memoria, queries de base de datos), que son útiles pero no responden "¿cuántas conversaciones escalaron hoy?" o "¿cuánto está gastando ForMotos en tokens este mes?".

## Opción evaluada: Grafana Cloud (free tier)

Datos de mercado (julio 2026): el free tier de Grafana Cloud incluye 10.000 series de métricas activas, 50 GB de logs (Loki) y 50 GB de trazas (Tempo) por mes, con 14 días de retención, sin tarjeta de crédito y sin fecha de expiración. Muy por encima del volumen esperado del piloto (~430 conversaciones/mes).

## Decisión
**Adoptar Grafana Cloud (free tier), usando Loki (logs estructurados) como base de las métricas de negocio**, no Prometheus/métricas numéricas separadas. Justificación: el sistema ya va a emitir logs estructurados por cada evento relevante (tool ejecutada, turno completado, escalamiento) para `audit_log` (Fase 4) — en vez de instrumentar además un cliente de métricas separado, esos mismos eventos se emiten también como líneas de log JSON a stdout, que se envían a Grafana Cloud. Los dashboards y alertas se construyen con consultas LogQL sobre esos campos (`tenant_id`, `tokens`, `latencia_ms`, `evento`), sin duplicar la instrumentación.

Se prefiere esto sobre construir una página de dashboard propia (como se hizo para la [vista del asesor](../fase-7-escalamiento-humano/vista-asesor.md), Fase 7) porque un dashboard de métricas con series de tiempo, agregaciones y alertas es trabajo de ingeniería no trivial — adoptar una herramienta gratuita y madura es más barato en esfuerzo que construirlo, a diferencia de la vista del asesor (que sí se justificó construir a medida, por ser una vista simple de solo lectura de datos de Postgres).

## Consecuencias
- El sistema debe emitir logs estructurados (JSON) a stdout de forma consistente desde el diseño del orquestador (Fase 4) — no es una capa separada, es una disciplina de logging aplicada desde el principio.
- El mecanismo exacto de envío de logs desde Fly.io a Grafana Cloud Loki se resuelve en implementación (agente de reenvío de logs o integración nativa de Fly.io).
- Si el volumen crece más allá del free tier (10.000 series o 50 GB/mes de logs), el siguiente escalón es el plan Pro de Grafana Cloud (~$19/mes de tarifa base + consumo) — costo bajo, revisar en la Fase 10.

## Fuentes consultadas (julio 2026)
- [Grafana Cloud Free Tier](https://grafana.com/products/cloud/free-tier/)
- [Grafana Cloud Pricing 2026 — CloudZero](https://www.cloudzero.com/blog/grafana-cloud-pricing/)
