# ADR-016: Parametrización de la marca del panel por tenant

## Estado
Aceptado.

## Contexto
El nombre de marca del panel está hardcodeado hoy en dos lugares: `"ForMotos"` en el `<title>` de `layout()` (`src/admin/adminPanel.ts:57`) y referencias equivalentes en `src/advisor/handoffView.ts`. El panel de referencia analizado para esta fase (producto externo "Forja", marca visible "HorizontesAgentOS") muestra ese nombre como un parámetro de marca en el encabezado del panel — no como texto fijo del producto.

Para que el mismo panel de agent-sale pueda escalar a distintos clientes sin editar código por cada cliente nuevo, el nombre mostrado debe salir de datos del tenant, no del código. ForMotos, el piloto actual, debe seguir viéndose igual sin requerir un seed adicional.

## Opciones consideradas

1. **Columna `tenants.display_name text` nullable, con fallback a `tenants.name`.** Cambio mínimo: una columna opcional, con `tenant.display_name ?? tenant.name` en el código de `layout()`.
2. **Columna `tenants.branding jsonb`** con nombre, color y logo desde el día uno. Cubre más necesidades de personalización visual futura, pero nada en el alcance actual de la Fase 11 pide color ni logo — sería diseño especulativo.
3. **Reusar `tenants.name` directamente**, sin columna nueva. Simple, pero acopla el nombre "operativo" del tenant (el que usan las queries internas y los logs) con el nombre "de marca" que se le muestra a alguien mirando el panel — pueden divergir (ej. razón social vs. nombre comercial).

## Decisión
**Opción 1: `tenants.display_name text` nullable, fallback a `tenants.name`.**

Mismo patrón que ya usó el proyecto para `tenants.escalation_config` (migración `0014`, agregada cuando se necesitó ese campo, no anticipada en el esquema inicial de `migrations/0002_tenants.cjs`): agregar la columna mínima que resuelve el problema actual, sin diseñar de más para necesidades hipotéticas (logo, color) que nadie pidió todavía.

- Migración nueva (siguiente número libre, ver [analitica-costos.md](../analitica-costos.md) para el resto de migraciones de esta fase): `ALTER TABLE tenants ADD COLUMN display_name text;`.
- En código: dondequiera que `layout()` (o su equivalente extendido) construya el encabezado del panel, usar `tenant.display_name ?? tenant.name`.
- Para el piloto, `display_name` queda `NULL` para ForMotos — no requiere seed ni migración de datos, el fallback a `name` ya produce "ForMotos" como hoy.
- Si en el futuro se necesita color o logo, se agrega una migración separada (`branding jsonb` o columnas puntuales) cuando un cliente real lo pida — no se resuelve preventivamente aquí.

## Consecuencias
- Todas las páginas del panel que hoy hardcodean `"ForMotos"` en el título (`adminPanel.ts:57`, referencias en `handoffView.ts`) pasan a leer `display_name`/`name` del tenant en contexto. Este cambio es parte de la [Fase 11.1](../overview-kpis.md), porque toca el `layout()` compartido por todas las páginas — se hace primero para no reabrir cada página nueva después.
- Escalar el panel a un cliente nuevo (ej. una segunda concesionaria) no requiere tocar código: basta con insertar el tenant con su `display_name` deseado.
- Esta ADR no resuelve aislamiento de acceso entre tenants — eso es responsabilidad de RLS (ya existente) y de la decisión de auth de [ADR-015](./ADR-015-alcance-autenticacion-panel.md), no de esta columna.
