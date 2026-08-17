# Checklist de Revisión de Seguridad

Consolida los controles de seguridad ya diseñados en fases anteriores más los que se agregan aquí, como checklist formal a ejecutar antes de operar con tráfico real (Fase 9). No introduce arquitectura nueva — es una revisión de lo ya decidido, más el cierre de vacíos.

## Controles ya diseñados en fases anteriores (verificar que se implementaron tal cual se documentaron)

| Control | Diseñado en | Qué verificar |
|---|---|---|
| Aislamiento multi-tenant (RLS) | [ADR-004](../fase-1-arquitectura/adrs/ADR-004-multi-tenancy-rls.md), [multi-tenant-rls.md](../fase-2-fundaciones/multi-tenant-rls.md) | El test de aislamiento (Fase 2) pasa en CI, y es un gate bloqueante — no opcional. |
| Gestión de secretos | [ADR-007](../fase-2-fundaciones/adrs/ADR-007-gestion-secretos.md) | Ningún secreto real en el repositorio (ni en `.env` de ejemplo), variables de entorno cifradas por entorno. |
| Verificación de firma del webhook | [webhook-contrato.md](../fase-3-whatsapp-gateway/webhook-contrato.md) | La verificación de `X-Twilio-Signature` ocurre **antes** de cualquier otro procesamiento, con comparación de tiempo constante. |
| Idempotencia | [idempotencia.md](../fase-3-whatsapp-gateway/idempotencia.md) | Ambas capas (transporte + negocio) implementadas, no solo una. |
| Tools no reciben `tenant_id` del LLM | [contratos-tools.md](../fase-1-arquitectura/contratos-tools.md) | El `tenant_id` se inyecta desde el contexto de sesión, nunca es un parámetro que el modelo pueda manipular. |

## Controles nuevos de esta fase

- **Rate limiting en el endpoint del webhook** — un límite de requests por IP/por tenant en el `gateway`, para que un abuso o un error de configuración en el lado de Twilio no sature el sistema. No estaba cubierto explícitamente en la Fase 3.
- **PII en logs** — los logs estructurados que se envían a Grafana Cloud ([ADR-009](./adrs/ADR-009-observabilidad.md)) no deben incluir el número de teléfono completo del cliente ni el contenido literal de mensajes con datos personales sensibles — se registra el `conversation_id`/`tenant_id` para correlación, y el texto de negocio (tools ejecutadas, montos, tiempos), no la conversación palabra por palabra. El historial completo de la conversación vive en Postgres (con RLS), no en el sistema de logs de terceros.
- **TLS en todas las conexiones** — conexión a Postgres (Supabase) y a Redis deben forzar TLS, no solo la conexión pública del webhook. Detalle de configuración a verificar en implementación (Fase 2/3), no una decisión de arquitectura nueva.
- **Revisión de permisos del token de GitHub/CI** — el pipeline (Fase 2) no debe tener más permisos de los necesarios para desplegar (ej. no debe poder borrar el repositorio ni modificar ramas protegidas).

## Cuándo se ejecuta este checklist

Antes de iniciar el piloto controlado con ForMotos (Fase 9) — no es un ejercicio de una sola vez en esta fase de diseño, sino un checklist que se re-ejecuta como parte del criterio de salida de la Fase 9 hacia producción real.

## Qué no cubre este documento
- Una auditoría de penetración formal — fuera de alcance para el tamaño actual del proyecto; se revisita si el número de tenants/PyMEs crece lo suficiente para justificar el costo (Fase 10).
