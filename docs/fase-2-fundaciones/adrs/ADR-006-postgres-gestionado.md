# ADR-006: Proveedor de PostgreSQL gestionado

## Estado
Aceptado.

## Contexto
Se necesita Postgres gestionado con soporte para `pgvector` (recomendaciones, ADR de la Fase 1) y Row Level Security (multi-tenancy, [ADR-004](../../fase-1-arquitectura/adrs/ADR-004-multi-tenancy-rls.md)). RLS es una función nativa de PostgreSQL — funciona igual en cualquier proveedor; lo que varía es la documentación, herramientas alrededor, y el modelo de costo.

## Opciones consideradas (datos de mercado, julio 2026)

| Proveedor | Modelo de costo | pgvector | RLS | Notas |
|---|---|---|---|---|
| **Supabase** | Desde $25/mes en plan pagado; tiene *free tier* sin tarjeta de crédito | Soportado, con guías oficiales | Documentado como función central de la plataforma (pensado para exponerse a un cliente vía su API auto-generada) | Es una plataforma "backend-as-a-service" completa (Auth, Storage, Realtime) — usaríamos **solo la base de datos Postgres**, para no acoplar la arquitectura a sus otros servicios |
| **Neon** | Desde $19/mes; cobra por cómputo, con *scale-to-zero* (no cobra cuando la base está inactiva) | Soportado, vía documentación estándar de PostgreSQL | RLS disponible como en cualquier Postgres, sin tooling adicional propio | Fuerte en *branching* de base de datos (copias instantáneas por PR) — útil para probar el aislamiento por RLS en cada Pull Request dentro del pipeline CI/CD |

## Decisión
**Empezar con el free tier de Supabase** para el piloto de ForMotos: costo cero mientras el volumen es bajo, con RLS y `pgvector` bien documentados, reduciendo riesgo de implementación en la Fase 2 de construcción. Se usa **exclusivamente como Postgres gestionado** — no se adopta Supabase Auth, Storage ni Realtime, para mantener el sistema portable a cualquier Postgres estándar si se decide migrar.

**Se documenta como decisión revisable:** si el flujo de CI/CD termina necesitando bases de datos efímeras por Pull Request para probar aislamiento multi-tenant de forma barata y rápida, **Neon es la alternativa a reevaluar** por su capacidad de *branching* instantáneo — ver [pipeline-ci-cd.md](../pipeline-ci-cd.md).

## Consecuencias
- La cadena de conexión a Postgres debe tratarse como configuración intercambiable (variable de entorno), nunca acoplada al SDK propio de Supabase, para no perder portabilidad.
- El free tier de Supabase tiene límites (cómputo, almacenamiento, conexiones concurrentes) que deben revisarse antes de escalar más allá del piloto — disparador para pasar a un plan pagado o reevaluar proveedor en la Fase 10 (Preparación para Escala).
