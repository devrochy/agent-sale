# ADR-032: Retiro de multi-tenancy — agent-sale pasa a atender un solo negocio

## Estado
Aceptada. **Supersede a [ADR-004](./ADR-004-multi-tenancy-rls.md)**, que queda marcada como Superada (no se borra — trazabilidad histórica, mismo criterio que ya usa el proyecto, ej. ADR-023 revirtiendo un punto de ADR-020).

## Contexto

ADR-004 (Fase 1) decidió multi-tenancy con Row Level Security desde la primera tabla, pensando en "múltiples PyMEs sobre la misma infraestructura". En la práctica, agent-sale nunca operó más de un negocio real — el piloto siempre fue ForMotos, y varios puntos del código ya asumían informalmente un solo tenant sin que nadie lo formalizara: el número de envío de WhatsApp es una única variable de entorno global (`sendMessage.ts`, no por tenant), el rate limiting es por IP y no por tenant ("mientras el piloto sea de un solo tenant", `server.ts`), y buena parte de los textos/ejemplos del prompt y del panel están hardcodeados a ForMotos.

El disparador concreto: al implementar el login real de administradores (Fase 13), cada URL del panel quedó con la forma `/admin/:tenantId/...` — incluido el login. Probándolo, resultó una fricción real y sin beneficio actual: había que buscar un UUID en la base de datos solo para poder loguearse, para un sistema que en la práctica y por decisión de negocio, va a seguir atendiendo un solo cliente indefinidamente. Frente a esa evidencia, se decidió revertir la decisión de ADR-004 en su totalidad, no solo en el login.

## Decisión

**Se retira multi-tenancy de todo el sistema — no solo del panel admin.** Cada tabla de negocio pierde su columna `tenant_id` y su política de Row Level Security; la tabla `tenants` se renombra a `settings` (una única fila, sin concepto de "tenant activo"); el helper `withTenant(tenantId, fn)` se simplifica a `withTransaction(fn)` (mismo BEGIN/COMMIT/ROLLBACK, sin `set_config('app.tenant_id', ...)`); cada función de dominio, cada ruta HTTP y cada test pierde el parámetro/segmento `tenantId`.

## Alternativas consideradas

- **Mantener multi-tenancy "por si acaso" un segundo cliente aparece más adelante.** Descartada: es exactamente el tipo de complejidad especulativa que el proyecto evita en otras decisiones (ver ADR-013, ADR-015 original) — pagar el costo de URLs/esquema/tests multi-tenant todos los días, para un beneficio que no existe hoy y que no está comprometido para ningún fecha. Si en el futuro el negocio decide atender un segundo cliente, el camino más simple para un proyecto de este tamaño no es resucitar RLS compartido — es un despliegue separado por cliente (base de datos y proceso propios), evaluado en ese momento con datos reales, no diseñado preventivamente ahora.
- **Solo simplificar el login (quitar `tenantId` de las rutas de `/admin/*`), dejar el resto del esquema multi-tenant intacto.** Descartada explícitamente por decisión del usuario: mantener RLS en el resto de las tablas sin ningún tenant real que lo necesite es la misma complejidad especulativa, solo que escondida un nivel más abajo (en el esquema, no en la URL) — no resuelve el problema de fondo, solo lo mueve.

## Consecuencias

- **Esquema**: `tenants` → `settings` (singleton). Las 17 tablas de negocio (`customers`, `conversations`, `messages`, `products`, `inventory`, `promotions`, `quotes`, `quote_items`, `orders`, `order_items`, `human_agents`, `handoff_queue`, `audit_log`, `llm_usage`, `reviews`, `admins`, `admin_permissions`) pierden `tenant_id`, su política `tenant_isolation` y `ENABLE`/`FORCE ROW LEVEL SECURITY`. Las tablas de resolución de token (`handoff_tokens`, `review_tokens`, `wompi_payment_links`, `admin_sessions`) pierden `tenant_id` también — ya no hay nada que resolver antes de una sesión, porque ya no hay sesión de tenant.
- **`migrations/0011_app_role.cjs` (rol `agent_sale_app` sin superuser/BYPASSRLS) se mantiene sin cambios** — es mínimo privilegio de conexión, una práctica independiente de si existe RLS o no.
- **Código**: `withTenant.ts` → `withTransaction.ts`; `tenantsDirectory.ts` → `settingsDirectory.ts`; el gateway deja de resolver tenant desde el número de WhatsApp entrante (`findTenantIdByWhatsappNumber` se retira); los jobs que iteraban `listTenants()` (`dailyReport.ts`, `cazadorDeVentas.ts`, `debounceScheduler.ts`) operan directo sobre el único negocio; todas las rutas `/admin/:tenantId/*` pierden el segmento.
- **Tests**: `tests/integration/rls-isolation.test.ts` se elimina por completo — no queda ninguna frontera de aislamiento que probar. El resto de la suite de integración pierde el boilerplate de sembrar/limpiar un tenant en cada archivo.
- **Seguridad**: el aislamiento entre negocios distintos deja de ser una garantía de la base de datos (RLS) porque deja de haber más de un negocio en la misma base — si esto cambia en el futuro, no es "reactivar RLS", es una decisión de arquitectura nueva evaluada desde cero (ver alternativas descartadas arriba).
- Esta ADR no aplica en las fases 0-12 documentadas como diseño de v2 en paralelo (`MASTER_PLAN_V2.md`) — a diferencia de esa regla, acá sí se actualiza documentación de v1 (`modelo-datos.md`, preámbulo de `MASTER_PLAN.md`) porque es exactamente lo que esta ADR corrige, no una adición en paralelo.
