# ADR-025: Autenticación real por administrador y modelo de permisos de colaboradores

## Estado
Aceptada (2026-08-02) — Rob confirmó arrancar la implementación de la Fase 13 siguiendo el orden recomendado de `MASTER_PLAN_V2.md`.

## Contexto

[ADR-015](../../fase-11-panel-admin-dashboard/adrs/ADR-015-alcance-autenticacion-panel.md) decidió mantener Basic Auth global "mientras exista un único tenant real", identificando explícitamente la Fase 10 como el disparador natural para revisar esto, y dejando una condición de reversión temprana: *"si antes de llegar a la Fase 10 se incorpora un segundo tenant piloto con necesidad real de que sus operadores no vean datos de otros tenants, esta decisión se revisita de inmediato"*.

`PROPUESTA_V2.md` §3.1 pide algo más específico que aislamiento entre tenants: **usuarios individuales dentro de un mismo tenant**, con roles (`master`/`colaborador`) y permisos granulares para decidir quién recibe qué notificación. Esto es una necesidad real de negocio (el equipo de ForMotos ya tiene más de una persona operando), no la necesidad hipotética de un segundo tenant que ADR-015 estaba evitando construir de forma especulativa. El disparador de ADR-015 (más de un operador necesitando accesos diferenciados) ya se activó.

## Opciones consideradas

1. **Sesiones con cookie firmada + tabla `admins` con hash de contraseña (bcrypt/scrypt).** Estándar, sin dependencias nuevas de infraestructura (no requiere un IdP externo). Requiere resolver expiración de sesión y, eventualmente, recuperación de contraseña.
2. **JWT sin estado (stateless), sin tabla de sesiones.** Evita una tabla de sesiones activas, pero complica la revocación inmediata (requisito explícito de la Fase 13: desactivar a un colaborador debe cortar su acceso de inmediato, no esperar a que expire un JWT ya emitido) — descartada por ese requisito puntual.
3. **Delegar a un proveedor de identidad externo (Auth0, Clerk, etc.).** Añade una dependencia de pago y de infraestructura externa que ningún otro punto del proyecto tiene (todo el resto de credenciales de terceros — Wompi, LLM — ya se maneja BYOK cifrado en Postgres, `secretBox.ts`) — descartada por consistencia con el patrón ya establecido y por costo, no justificado para el tamaño actual del equipo.

## Decisión

**Opción 1: sesiones con cookie firmada, tabla `admins` propia, revocación inmediata vía tabla de sesiones activas.**

### Esquema

```
admins
  id                uuid PK
  tenant_id         uuid FK
  email             text unique (por tenant)
  password_hash     text
  role              text CHECK (role IN ('master', 'colaborador'))
  active            boolean DEFAULT true
  created_at        timestamptz

admin_permissions
  admin_id                    uuid FK → admins.id
  recibe_reporte_diario       boolean DEFAULT false
  recibe_tickets              boolean DEFAULT false
  recibe_notificacion_pagos   boolean DEFAULT false
```

Un administrador `master` siempre tiene todos los permisos implícitos (no se le puede quitar el acceso a nada dentro de su propio tenant) — evita el caso de un tenant sin ningún administrador con un permiso crítico activo.

### Sesiones

Tabla `admin_sessions` (`id`, `admin_id`, `created_at`, `expires_at`) — cookie firmada guarda solo el `id` de sesión, no el `admin_id` ni ningún dato en claro. Desactivar un colaborador (`admins.active = false`) invalida todas sus sesiones activas en la siguiente petición (chequeo `admins.active` en el middleware de sesión, no solo al momento del login) — esto es lo que garantiza la revocación inmediata que descartó la Opción 2.

### Reemplazo del hook de Basic Auth

`src/gateway/server.ts:59-69` se reemplaza por un middleware que resuelve la sesión desde la cookie y adjunta el `admin` autenticado (con tenant y permisos) al request. El reemplazo es atómico (un solo deploy) — no coexisten ambos mecanismos, para no dejar una ruta cubierta por el sistema viejo y otra por el nuevo.

### Recuperación de contraseña — fuera del alcance inicial

No existe hoy ningún canal de email en el proyecto, y WhatsApp no es un canal apropiado para enviar un enlace de reseteo de contraseña (mismo tipo de dato sensible que ya evita el proyecto en otros puntos). Para el alcance inicial de la Fase 13, un administrador *master* puede resetear la contraseña de un colaborador manualmente desde la sección de Colaboradores (genera una contraseña temporal, se la comunica por el canal que el equipo ya use fuera del sistema) — self-service de recuperación queda como iteración futura si el volumen de administradores lo justifica.

## Consecuencias

- Todas las rutas `/admin/:tenantId/*` requieren sesión válida; ninguna queda bajo Basic Auth tras el despliegue de esta fase.
- El aislamiento de datos entre tenants lo sigue garantizando RLS (ya existente, ADR-004) — esta ADR resuelve identidad *dentro* de un tenant, no reemplaza RLS.
- Esta ADR **no** se ejecuta como parte de la Fase 10 de `MASTER_PLAN.md` (prueba de carga, runbook de onboarding, escalado de infraestructura) — ver la nota de alcance en `MASTER_PLAN_V2.md#fase-13`. La Fase 10 original sigue intacta y pendiente de iniciar cuando el negocio la priorice.
- `dailyReport.ts` y la notificación de pago aprobado de ADR-024 pasan de un destinatario fijo (`tenants.report_recipient_phone`) a resolver la lista de administradores con el permiso correspondiente activo — `report_recipient_phone` puede mantenerse como fallback si ningún administrador tiene el permiso marcado (evita perder la notificación por un olvido de configuración).
