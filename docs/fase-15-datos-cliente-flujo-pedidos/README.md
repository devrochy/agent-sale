# Fase 15 — Datos de Cliente y Flujo de Pedidos Extendido

Estado: **en diseño** (v2)

Referencia: [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md#fase-15--datos-de-cliente-y-flujo-de-pedidos-extendido) · [PROPUESTA_V2.md §3.2](../../PROPUESTA_V2.md) · [Fase 6 — Dominio Comercial](../fase-6-dominio-comercial/flujo-cotizacion-pedido.md) · [Fase 14 — Catálogo Extendido](../fase-14-catalogo-extendido/README.md)

Que el asistente capture y confirme progresivamente dirección, cédula y nombre completo del cliente al cerrar un pedido, con opción de cambio temporal o permanente, y que un pedido abierto pueda seguir recibiendo productos antes de cerrarse — sin crear un segundo pedido.

## Relación con v1

- **Extiende** `customers` (`migrations/0003_customers.cjs`, hoy solo `phone_number`/`name`/`created_at`) y [`flujo-cotizacion-pedido.md`](../fase-6-dominio-comercial/flujo-cotizacion-pedido.md) (Fase 6) — no choca con ninguna ADR aceptada, es una extensión directa del flujo ya diseñado ahí.
- No es una tabla nueva de datos de cliente separada: se agrega a `customers` directamente, siguiendo el mismo criterio incremental que ya usó el proyecto para `tenants.display_name` (ADR-016) o `tenants.escalation_config` (migración 0014) — columnas nuevas nullable, sin romper el esquema existente.

## Contenido de esta fase

Esta fase no introduce una decisión de arquitectura nueva que amerite ADR propia — extiende el flujo conversacional ya diseñado en Fase 6 con datos adicionales y una tool de "agregar ítem a pedido abierto", siguiendo el mismo principio rector de `contratos-tools.md` ("el LLM propone, la tool decide"). El único punto que sí requiere una decisión explícita en implementación (documentado como nota de diseño, no como ADR separada) es si "agregar producto a un pedido abierto" es una tool nueva con su propia `idempotency_key` o una reapertura del `quote_id` original — se resuelve al iniciar la implementación, con el mismo criterio de idempotencia que ya exige `crear_pedido` (`docs/fase-1-arquitectura/contratos-tools.md`).

## Dependencias

**Fase 14** — para que los `order_items` que se agreguen a un pedido abierto ya referencien `variant_id` desde el primer día, evitando una segunda migración sobre la misma tabla.

## Riesgos

- Reabrir un pedido "confirmado" para agregar productos puede chocar con el principio de idempotencia si no se define correctamente el mecanismo (ver nota arriba).
- Cédula es información sensible — revisar si aplica alguna consideración de protección de datos personales antes de almacenarla en texto plano en `customers`.

## Definición de terminado

- [ ] Un cliente nuevo recibe la solicitud de dirección/cédula/nombre antes de que el pedido se confirme; uno existente ve sus datos y puede confirmarlos o cambiarlos.
- [ ] Un pedido `abierto` recibe un producto adicional sin generar un segundo `order_id`, verificado con un caso de prueba de punta a punta.
- [ ] Cambio "temporal" no persiste en `customers`; cambio "permanente" sí, verificado contra la base tras la conversación.

Siguiente paso: [Fase 16 — Estado de Pedido, Pagos y Logística](../fase-16-estado-pedido-pagos-logistica/README.md), que depende de esta fase por compartir el mismo dominio de `orders`.
