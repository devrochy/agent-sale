# Fase 2 — Fundaciones de Plataforma (Infra base, CI/CD, Multi-tenant)

Estado: **completada** (rama `feature/fase-2-fundaciones`)

Referencia: [MASTER_PLAN.md](../../MASTER_PLAN.md#fase-2--fundaciones-de-plataforma-infra-base-cicd-multi-tenant) · [Fase 1 — Arquitectura](../fase-1-arquitectura/README.md)

Esta fase, igual que las Fases 0 y 1, se trabajó como **diseño y documentación** — sin escribir código ni aprovisionar infraestructura real todavía. Los archivos de configuración reales (Dockerfile, `fly.toml`, YAML de GitHub Actions) se crean al iniciar la implementación de código, fuera del alcance de este plan de arquitectura.

## Contenido de esta fase

- [estructura-repositorio.md](./estructura-repositorio.md) — organización de carpetas del monolito modular.
- [pipeline-ci-cd.md](./pipeline-ci-cd.md) — etapas del pipeline, entornos, y el test de aislamiento RLS como gate bloqueante.
- [multi-tenant-rls.md](./multi-tenant-rls.md) — cómo se setea el tenant activo por conversación y cómo se verifica el aislamiento.
- [adrs/ADR-005-hosting-monolito.md](./adrs/ADR-005-hosting-monolito.md) — Fly.io, con costo real comparado contra Render y Railway.
- [adrs/ADR-006-postgres-gestionado.md](./adrs/ADR-006-postgres-gestionado.md) — Supabase (solo como Postgres), con Neon como alternativa documentada.
- [adrs/ADR-007-gestion-secretos.md](./adrs/ADR-007-gestion-secretos.md) — secretos nativos de cada plataforma, sin vault dedicado todavía.

## Definición de terminado

- [x] Estructura de repositorio modular por dominio documentada.
- [x] Pipeline CI/CD diseñado (lint → test → test de aislamiento RLS → build → deploy staging automático → aprobación manual → deploy producción).
- [x] Proveedor de Postgres elegido con RLS y `pgvector` soportados (Supabase, free tier).
- [x] Gestión de secretos definida (nativa de GitHub Actions + Fly.io + Supabase, sin vault dedicado).
- [x] Plan de test de aislamiento multi-tenant documentado como gate bloqueante del pipeline.

**Nota:** las decisiones de ADR-005/006 se basan en datos públicos de mercado (julio 2026), no en cotización oficial. Se recomienda confirmar límites exactos del free tier de Supabase y precio real de Fly.io al iniciar la implementación.

**Fase 2 completada.** Siguiente paso: Fase 3 — Integración con WhatsApp (BSP) y Gateway de Mensajería.
