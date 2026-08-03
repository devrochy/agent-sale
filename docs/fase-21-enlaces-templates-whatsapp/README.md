# Fase 21 — Enlaces Amigables y Templates Interactivos de WhatsApp

Estado: **en diseño** (v2)

Referencia: [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md#fase-21--enlaces-amigables-y-templates-interactivos-de-whatsapp) · [PROPUESTA_V2.md §3.9](../../PROPUESTA_V2.md) · [ADR-019 — Mensajería proactiva ventana 24h](../fase-12-capacidades-proactivas-agente/adrs/ADR-019-mensajeria-proactiva-ventana-24h.md) · [ADR-024 — Cobros Wompi](../fase-12-capacidades-proactivas-agente/adrs/ADR-024-cobros-wompi-confirmacion-automatica.md) · [Fase 16](../fase-16-estado-pedido-pagos-logistica/README.md)

Que ningún enlace enviado por el asistente (pago, reseñas) se muestre como URL cruda, y que el cierre de pedido se ofrezca como opciones seleccionables (template de WhatsApp) en vez de texto libre.

## Relación con v1

- **Extiende** `src/gateway/messageSplitter.ts` y `extractPaymentLinkUrl` (ADR-024) — hoy el link de pago se anexa como texto plano al final del mensaje; esta fase cambia el formato de presentación, no el mecanismo de extracción determinística ya validado.
- **Extiende** el mecanismo de plantillas de WhatsApp de **ADR-019**, que ya distingue mensajes dentro de la ventana de 24h (texto libre) de los que la requieren (plantillas aprobadas por Meta) — el template de botones de cierre de pedido es una plantilla nueva, sujeta al mismo mecanismo de aprobación.
- Reseñas (`src/reviews/reviewView.ts`, enlace generado en Fase 12.2) se beneficia del mismo cambio de presentación de enlaces.

## Contenido de esta fase

- [adrs/ADR-031-templates-interactivos-y-presentacion-enlaces.md](./adrs/ADR-031-templates-interactivos-y-presentacion-enlaces.md) — formato de hipervínculo dentro de los límites reales de la API de WhatsApp, y diseño del template de botones con su fallback a texto libre.

## Dependencias

**Fase 16** — los botones de cierre de pedido necesitan los estados de pedido ya definidos ahí.

## Riesgos

- Toda plantilla nueva de WhatsApp requiere aprobación de Meta — mismo bloqueo no controlable que ya vive la Fase 12.3 (`PROPUESTA_V2.md` §4 exige no reabrir esa decisión ni saltarse el mecanismo de aprobación).
- Si Meta rechaza o tarda en aprobar el template, el flujo debe degradar a texto libre sin bloquear el cierre de pedido.

## Definición de terminado

- [ ] Un pago de Wompi y un enlace de reseña llegan como hipervínculo con texto descriptivo, nunca como URL cruda, verificado en WhatsApp real.
- [ ] Al menos una plantilla de botones de cierre de pedido aprobada por Meta y operando; si no se logra antes del cierre de la fase, el fallback a texto libre queda documentado y funcionando.

Puede ejecutarse en paralelo con las Fases 17-20, respetando su dependencia de la Fase 16.
