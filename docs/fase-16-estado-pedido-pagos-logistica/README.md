# Fase 16 — Estado de Pedido, Pagos y Logística

Estado: **en diseño** (v2)

Referencia: [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md#fase-16--estado-de-pedido-pagos-y-logística) · [PROPUESTA_V2.md §3.3](../../PROPUESTA_V2.md) · [ADR-024 — Cobros Wompi](../fase-12-capacidades-proactivas-agente/adrs/ADR-024-cobros-wompi-confirmacion-automatica.md) · [ADR-018 — Jobs programados](../fase-12-capacidades-proactivas-agente/adrs/ADR-018-infraestructura-jobs-programados.md) · [Fase 15](../fase-15-datos-cliente-flujo-pedidos/README.md)

Cierra el ciclo de vida del pedido después de creado: número público de seguimiento, cierre automático de pendientes sin pago a los 5 días, y registro/notificación de guía de envío — reutilizando la infraestructura de pagos y jobs ya construida en la Fase 12.4.

## Relación con v1

- **Extiende** `orders.payment_status` (ADR-024, `migrations/0030_orders_payment_status.cjs`) — el estado ya existe (`pendiente`/`pagado`), esta fase lo hace visible en el panel y le agrega número público + logística, no cambia su semántica.
- **Extiende** el patrón `node-cron` de ADR-018 con un job nuevo (cierre automático a 5 días), mismo criterio que los 4 jobs ya implementados en Fase 12.2 (reporte diario, cazador de ventas, encuestas, reseñas).
- **Extiende** el mecanismo de notificación de pago de ADR-024 (hoy a `tenants.report_recipient_phone`) para redirigirlo a los administradores con permiso `recibe_notificacion_pagos` (Fase 13).

## Contenido de esta fase

Sin ADR propia — es una extensión directa de patrones ya aceptados (ADR-018, ADR-024), sin una decisión de arquitectura nueva que registrar. La única regla de diseño explícita a respetar en implementación: el job de cierre automático a 5 días opera **solo** sobre `payment_method = 'pago_en_linea'` — los otros 3 métodos (`transferencia`, `efectivo_contraentrega`, `tarjeta`) nacen `payment_status = 'pagado'` por diseño de ADR-024 y nunca deben entrar en la lógica de "pendiente sin pago".

## Dependencias

**Fase 15** — mismo dominio de `orders`, se ejecuta después para evitar dos rondas de migración sobre la misma tabla.

## Riesgos

- Excluir correctamente los métodos sin verificación digital del job de cierre automático (ver regla arriba) — un bug acá cancelaría pedidos legítimos pagados por transferencia.
- Doble notificación si el pago se confirma justo en el borde de los 5 días — mitigar con el mismo criterio idempotente que ya usa el webhook de Wompi (`WHERE payment_status = 'pendiente'`).

## Definición de terminado

- [ ] Un pedido con `pago_en_linea` pendiente por 5+ días pasa a `cancelado`/`expirado` automáticamente, verificado con un caso de prueba con fecha adelantada.
- [ ] El cliente puede preguntar por su número de pedido público (ej. "¿cómo va mi pedido FM-0001?") y el agente responde el estado real.
- [ ] Registrar una guía desde el panel dispara la notificación de WhatsApp al cliente correcto, verificado end-to-end.

Siguiente paso: [Fase 17 — Motor de Promociones Avanzado](../fase-17-motor-promociones-avanzado/README.md), que depende del historial de `orders` de esta fase para la clasificación de clientes.
