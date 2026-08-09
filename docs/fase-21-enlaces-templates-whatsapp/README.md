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

**Corregido (2026-08-08, contra la documentación vigente de Twilio y Meta):** el riesgo que esta fase declaraba como dominante era falso para su alcance. Dentro de la ventana de 24h los botones **no requieren aprobación de Meta** — máximo 3, todos del mismo tipo, `QUICK_REPLY`/`URL`. Todo lo que pide esta fase es in-session, porque siempre responde a un mensaje del cliente. La aprobación sigue siendo obligatoria fuera de la ventana de 24h, que es la Fase 12.3, no esta.

- **Bloqueo real:** el sandbox de Twilio no admite content templates propios, y el proyecto opera sobre el número compartido de sandbox. Se resuelve saliendo del sandbox (sender propio) o con Meta Cloud API.
- **Dependencia de orden:** esta fase se construye sobre el contrato de adapters de la [Fase 19](../fase-19-integracion-multicanal/README.md) (Etapa A, ya implementada). Hacerla antes sobre Twilio Content API habría sido trabajo desechable — ADR-031 ya lo anticipaba al describir el cambio de enlaces como "un cambio de forma de envío (`sendMessage.ts`/adapter de canal, ver Fase 19)".
- Los 3 botones del cierre de pedido caben exactamente en el límite in-session: un cuarto rompería el envío.
- Si un envío con botones falla, el flujo degrada a texto libre sin bloquear el cierre de pedido.

## Definición de terminado

- [ ] Un pago de Wompi y un enlace de reseña llegan como hipervínculo con texto descriptivo, nunca como URL cruda, verificado en WhatsApp real.
- [ ] Al menos una plantilla de botones de cierre de pedido aprobada por Meta y operando; si no se logra antes del cierre de la fase, el fallback a texto libre queda documentado y funcionando.

Puede ejecutarse en paralelo con las Fases 17-20, respetando su dependencia de la Fase 16.
