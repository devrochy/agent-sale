# Fase 13 — Autenticación Real, Roles de Colaborador y Notificaciones Administrativas

Estado: **en implementación** (v2) — ADR-025 aceptada 2026-08-02, primer incremento en `feature/impl-fase13-auth-colaboradores`.

Referencia: [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md#fase-13--autenticación-real-roles-de-colaborador-y-notificaciones-administrativas) · [PROPUESTA_V2.md §3.1, §3.4](../../PROPUESTA_V2.md) · [Fase 11 — Panel de Administración](../fase-11-panel-admin-dashboard/README.md) · [ADR-015](../fase-11-panel-admin-dashboard/adrs/ADR-015-alcance-autenticacion-panel.md)

Reemplaza el Basic Auth global de todo `/admin/*` (una sola credencial `ADMIN_USER`/`ADMIN_PASSWORD`, ver ADR-015) por login individual con sesiones y una tabla de administradores con permisos granulares, y hace que las notificaciones/reportes ya existentes (Fase 12.2, ADR-024) se dirijan a quien tenga el permiso correspondiente en vez de a un único destinatario fijo por tenant.

## Relación con v1

- **Reabre el disparador que ADR-015 dejó explícito**: "el disparador natural para revisar esto ya está identificado... la Fase 10". No se ejecuta como parte de la Fase 10 original (`MASTER_PLAN.md`, prueba de carga/runbook de onboarding) — ver la nota de alcance en `MASTER_PLAN_V2.md#fase-13` sobre por qué se separan.
- **Extiende** `src/jobs/dailyReport.ts` (Fase 12.2) y el destinatario único de notificación de pago de ADR-024 (`tenants.report_recipient_phone`) — pasan a resolverse contra la lista de administradores con permiso activo, no un solo teléfono.

## Contenido de esta fase

- [adrs/ADR-025-autenticacion-real-y-permisos-colaboradores.md](./adrs/ADR-025-autenticacion-real-y-permisos-colaboradores.md) — mecanismo de sesión, modelo de tabla de administradores/permisos, y por qué se ejecuta como fase propia y no dentro de la Fase 10.

## Definición de terminado

- [x] Ningún acceso a `/admin/*` funciona ya con la credencial Basic Auth global; login individual obligatorio, hook de `src/gateway/server.ts` reemplazado (`GET /admin` sin tenantId pasó a página neutra sin datos, ver adenda de ADR-025).
- [ ] Tabla `admins` con roles (`master`/`colaborador`) y permisos granulares (`recibe_reporte_diario`, `recibe_tickets`, `recibe_notificacion_pagos`) funcionando end-to-end.
- [ ] Un administrador *master* puede desactivar a un colaborador y esa cuenta pierde acceso de inmediato (sesión invalidada).
- [ ] Reporte diario (Fase 12.2) y notificación de pago aprobado (ADR-024) llegan solo a administradores con el permiso correspondiente, verificado con al menos 2 administradores de prueba con permisos distintos.

Siguiente paso: [Fase 14 — Esquema de Catálogo Extendido](../fase-14-catalogo-extendido/README.md) (sin dependencia técnica de esta fase, pero primera en la secuencia recomendada de `MASTER_PLAN_V2.md`).
