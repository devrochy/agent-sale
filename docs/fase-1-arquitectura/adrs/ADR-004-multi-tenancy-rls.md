# ADR-004: Multi-tenancy con Row Level Security

## Estado
**Superada por [ADR-032](./ADR-032-retiro-multi-tenancy.md)** — agent-sale dejó de ser multi-tenant; se mantiene este documento por trazabilidad histórica, no describe el sistema actual.

## Contexto
La plataforma atenderá múltiples PyMEs (tenants) sobre la misma infraestructura. Un error de aislamiento entre tenants (que un dato de ForMotos sea visible para otro cliente) es uno de los riesgos más graves identificados para este proyecto — y uno de los más caros de corregir si se descubre tarde.

## Decisión
Cada tabla de negocio en Postgres incluye una columna `tenant_id`, protegida por una política de **Row Level Security** desde su creación (no como capa añadida después). La sesión de base de datos fija el tenant activo (`current_setting('app.tenant_id')`) al inicio de cada turno de conversación, resuelto a partir del número de WhatsApp entrante.

## Alternativas descartadas
- **Base de datos separada por tenant**: aísla mejor, pero es operacionalmente caro (migraciones, backups y conexiones multiplicadas por cada PyME cliente) y contradice el requisito de bajo costo para un proyecto que apunta a muchas PyMEs pequeñas.
- **Aislamiento solo a nivel de aplicación** (sin RLS, solo `WHERE tenant_id = ...` en cada query): frágil — un único query mal escrito filtra datos entre tenants sin que la base de datos lo impida.

## Consecuencias
- Toda migración de esquema debe incluir la política RLS correspondiente como parte del mismo cambio, no como tarea separada.
- Se requiere un test de aislamiento (un tenant no puede leer datos de otro) como parte de la Definición de Terminado de la Fase 2, antes de construir cualquier módulo de negocio sobre esta base.
