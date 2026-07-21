# Plan de aislamiento multi-tenant (Row Level Security)

Complementa la decisión de [ADR-004](../fase-1-arquitectura/adrs/ADR-004-multi-tenancy-rls.md) (Fase 1) con el plan concreto de cómo se implementa y se verifica.

## Cómo se setea el tenant activo

1. Cada mensaje entrante llega con un número de WhatsApp de origen (el negocio, ej. ForMotos) — el `gateway` lo resuelve a un `tenant_id` real contra la tabla `tenants` antes de encolar el mensaje.
2. El `orchestrator`, al tomar el mensaje de la cola, abre la conexión a Postgres y ejecuta `SET app.tenant_id = '<uuid>'` (o el mecanismo equivalente de `SET LOCAL` dentro de una transacción) **antes** de cualquier otra query en ese turno.
3. Ninguna query de dominio (`domains/*`) recibe `tenant_id` como parámetro explícito — confía en que la sesión ya lo tiene seteado. Esto es intencional: si un desarrollador olvida filtrar por tenant en una query nueva, la base de datos igual lo bloquea por la política RLS, en vez de depender de que cada query lo recuerde hacer bien.

## Patrón de acceso a datos

Todo acceso a Postgres pasa por `shared/db` (ver [estructura-repositorio.md](./estructura-repositorio.md)), que es responsable de:
- Setear `app.tenant_id` al abrir cada conexión/transacción.
- Exponer un cliente de base de datos a los dominios que **no** permite pasar `tenant_id` manualmente en una query — evita el error humano de "olvidé el WHERE tenant_id=...", porque ese filtro nunca debería escribirse a mano.

## Test de aislamiento (bloqueante en CI/CD)

Antes de construir cualquier módulo de negocio sobre esta base, debe existir y pasar un test que:
1. Crea dos tenants de prueba (`tenant_a`, `tenant_b`) con datos de ejemplo en al menos `products` y `orders`.
2. Abre una sesión con `app.tenant_id = tenant_a`.
3. Verifica que ninguna query devuelve ni permite modificar filas de `tenant_b`, incluso si se intenta explícitamente.
4. Se ejecuta en cada corrida de CI (ver [pipeline-ci-cd.md](./pipeline-ci-cd.md)) — no es un test manual ocasional, es parte del gate de merge.

## Qué pasa si un tenant necesita aislamiento reforzado (excepción futura)

Si en el futuro un tenant grande exige aislamiento físico (base de datos separada) por contrato o regulación, el diseño actual lo permite sin rediseño: `shared/db` puede resolver a una conexión distinta según `tenant_id`, ya que ningún dominio abre conexiones por su cuenta. No se construye esa capacidad ahora (no hay ese requisito hoy — ver principio de no diseñar para hipotéticos), solo se deja constancia de que el diseño no lo bloquea.
