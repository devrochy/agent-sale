# ADR-015: Alcance de autenticación del panel admin

## Estado
Aceptado.

## Contexto
Hoy todo `/admin/*` está protegido por un único hook de Basic Auth (`src/gateway/server.ts:59-69`) que compara contra una sola credencial global (`ADMIN_USER`/`ADMIN_PASSWORD`, comparación timing-safe con `safeEqual`). No hay sesiones, no hay usuarios, no hay credenciales por tenant — cualquiera con esa única contraseña ve todos los tenants.

La Fase 11 multiplica la superficie del panel (Conversaciones, Leads, Tickets, Flujo, Conexiones, Configuración, Analítica) y agrega el requisito explícito de parametrizar el panel por tenant ([ADR-016](./ADR-016-parametrizacion-marca-tenant.md)) para poder escalarlo a distintos clientes. Eso plantea la pregunta de si ese momento de "más superficie + multi-cliente" ya justifica introducir autenticación real por tenant.

## Opciones consideradas

1. **Login por tenant con sesiones.** Cada cliente (ej. ForMotos) tendría su propia cuenta y solo vería sus propios datos sin depender de una URL con `tenantId` "de confianza". Requiere: registro/gestión de usuarios, hashing de contraseñas, manejo de sesiones (cookies firmadas o JWT), recuperación de contraseña — un subsistema de identidad completo que hoy no existe en ningún punto del proyecto.
2. **Mantener Basic Auth global de una sola credencial**, sin cambios respecto a hoy.

## Decisión
**Opción 2: mantener Basic Auth global, sin login por tenant, en esta fase.**

Razones:
- El panel sigue siendo, tal como dice el comentario actual de `adminPanel.ts:1-9`, una herramienta operada por el equipo de agent-sale para el piloto — no un portal self-service donde el dueño de ForMotos entra con su propia cuenta. Que el panel tenga más pantallas no cambia quién lo opera.
- El proyecto está en piloto de **un solo tenant real** (ForMotos). Construir identidad multi-usuario/multi-tenant antes de que exista un segundo tenant con acceso simultáneo es exactamente el tipo de complejidad que otras decisiones del proyecto difieren hasta que el problema es real (mismo criterio que [ADR-013](../../fase-9-piloto-controlado/adrs/ADR-013-mecanismo-catalogo-piloto.md) usa para no automatizar la sincronización de catálogo con bajo volumen).
- El disparador natural para revisar esto ya está identificado en el propio `MASTER_PLAN.md`: la **Fase 10 — Preparación para Escala y Lanzamiento Multi-tenant**, cuyo objetivo explícito incluye "habilitar la incorporación repetible de nuevos tenants". Introducir identidad por tenant ahí, cuando de verdad haya más de un cliente usando el panel, evita construir un sistema de login especulativo hoy.
- La [vista de asesor](../../fase-7-escalamiento-humano/vista-asesor.md) ya usa el mismo argumento para justificar su propio mecanismo de acceso simple (token en URL) en vez de login completo — esta decisión es consistente con ese precedente.

## Consecuencias
- Todas las rutas nuevas de la Fase 11 (`/admin/:tenantId/...`) quedan bajo el mismo hook de Basic Auth existente, sin cambios en `src/gateway/server.ts:59-69`.
- Con Basic Auth global, cualquier operador con la credencial ve todos los tenants — aceptable mientras exista un solo tenant real, pero es una fuga de aislamiento cuando haya un segundo. Se documenta explícitamente como el ítem a resolver en la Fase 10 real, no se debe interpretar como "resuelto" por esta ADR.
- Si antes de llegar a la Fase 10 se incorpora un segundo tenant piloto con necesidad real de que sus operadores no vean datos de otros tenants, esta decisión se revisita de inmediato — no se espera a que la Fase 10 completa esté planificada.
