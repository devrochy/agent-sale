# Fase 12 — Capacidades Proactivas del Agente

Estado: **en diseño**

Referencia: [MASTER_PLAN.md](../../MASTER_PLAN.md#fase-12--capacidades-proactivas-del-agente) · [Fase 11 — Panel de Administración y Analítica](../fase-11-panel-admin-dashboard/README.md) · [Fase 7 — Escalamiento a Humano](../fase-7-escalamiento-humano/README.md) · [Fase 3 — Integración con WhatsApp](../fase-3-whatsapp-gateway/README.md) · [Comparativa de arquitectura con Forja](../comparativa-arquitectura-forja.md)

Durante el diseño de la Fase 11 se analizó un panel de referencia externo ("Forja"/"HorizontesAgentOS") cuya sección de upsell (`/admin/upgrade`) lista "12 superpoderes" — capacidades que van más allá de mostrar datos en un panel: son comportamiento nuevo del agente (seguimiento proactivo, guardrails más estrictos, reportes automáticos, multimodalidad). Por eso viven en una fase separada de la Fase 11, aunque varias de ellas terminen mostrando su resultado en el panel admin ya diseñado ahí.

En agent-sale ninguna de estas capacidades se adopta como "función de pago" — el análisis solo evalúa valor real para el asistente de ventas de ForMotos y factibilidad sobre la arquitectura actual.

## Contenido de esta fase

- [analisis-superpoderes.md](./analisis-superpoderes.md) — las 12 capacidades evaluadas una por una contra el código real: qué ya existe (más de lo esperado — handoff con contexto, guardrail de precio, y el canal de WhatsApp saliente genérico ya cubren varias total o parcialmente), qué falta, y qué depende de un bloqueo externo (aprobación de plantillas de WhatsApp por Meta).
- [adrs/ADR-018-infraestructura-jobs-programados.md](./adrs/ADR-018-infraestructura-jobs-programados.md) — `node-cron` en el mismo proceso, sin infraestructura distribuida (justificado porque Fly.io corre una sola instancia siempre activa, ADR-005).
- [adrs/ADR-019-mensajeria-proactiva-ventana-24h.md](./adrs/ADR-019-mensajeria-proactiva-ventana-24h.md) — qué mensajes proactivos son viables hoy (dentro de la ventana de 24h de WhatsApp) vs cuáles requieren plantillas aprobadas por Meta.
- [adrs/ADR-024-cobros-wompi-confirmacion-automatica.md](./adrs/ADR-024-cobros-wompi-confirmacion-automatica.md) — Cobros por WhatsApp con Wompi: link de pago único que cubre tarjeta/PSE/Nequi/Bancolombia Transfer, confirmación automática vía webhook (reversión del alcance "manual" que había estimado `comparativa-arquitectura-forja.md`).

## Priorización recomendada (detalle en `analisis-superpoderes.md`)

1. **12.1 — Quick wins**: multi-idioma, extender el guardrail de invención a stock, superficie de "Vigilante" (mayormente ya construido en la Fase 7).
2. **12.2 — Jobs programados + mensajería dentro de 24h: completa.** Reporte diario, cazador de ventas, encuestas de satisfacción y reseñas — todo implementado, ver [analisis-superpoderes.md](./analisis-superpoderes.md).
3. **12.3 — Bloqueada por Meta**: reactivación de leads fríos (fuera de la ventana de 24h, requiere plantillas aprobadas).
4. **12.4 — Cobros por WhatsApp: completa.** Wompi + confirmación automática, ver [ADR-024](./adrs/ADR-024-cobros-wompi-confirmacion-automatica.md).
5. **Fuera de esta fase, candidata a fase propia**: multimodalidad (voz/imágenes entrantes) — alto esfuerzo, integración externa (STT/visión) que amerita su propio diseño detallado.

**Una estimación de esta tabla se revisó a la baja** en [comparativa-arquitectura-forja.md](../comparativa-arquitectura-forja.md#qué-proponemos-como-mejora-futura-con-esfuerzo-revisado-a-la-baja-frente-a-estimaciones-previas) y luego se implementó con un ajuste adicional pedido por el usuario: Reporte diario (#7) puede empezar como comando bajo demanda en el panel, sin esperar a `node-cron` (ADR-018) — en la práctica se implementó directo como job programado. Cobros (#12) se había estimado como Payment Link con confirmación manual; el usuario pidió en cambio confirmación automática vía webhook (ver ADR-024) — el esfuerzo real terminó siendo Medio/Bajo de todas formas, gracias al mismo patrón ya usado para verificar la firma de Twilio.

## Riesgos

- **Plantillas de WhatsApp aprobadas por Meta** (bloqueo de 12.3) tiene tiempo de espera no controlable — mismo riesgo que la Fase 3 ya documentó para la verificación de cuenta BSP.
- **Alcance de "Voz de marca"** sigue bloqueado por la misma razón que en la Fase 11.4 (prompt byte-idéntico para caching) — no se resuelve aquí tampoco, se repite la referencia para que quede trazable desde ambos lados.
- **Multimodalidad** queda fuera de esta fase deliberadamente — incluirla de forma superficial aquí sería subestimar su esfuerzo real (integración externa completa de STT/visión, no una extensión del código actual).
- **Cuenta comercial de Wompi en producción** (12.4) es un prerrequisito de negocio, no técnico — mismo tipo de bloqueo que la cuenta BSP de WhatsApp en `pendientes-pre-piloto.md` (Fase 9). No bloquea el desarrollo: se construyó y probó contra sandbox.

## Definición de terminado

- [x] 12.1 (quick wins) implementado y verificado con datos reales de ForMotos (PR #36, mergeado).
- [x] `node-cron` (ADR-018) implementado con los 4 jobs de 12.2, verificados con WhatsApp real (Reporte diario, Cazador de ventas, Encuestas, Reseñas).
- [x] Cazador de ventas, Encuestas y Reseñas (12.2) implementados y respetando el límite de 24h de ADR-019 (verificado: ningún envío proactivo se intenta fuera de la ventana sin plantilla aprobada).
- [x] Cobros por WhatsApp (12.4) implementado con Wompi y confirmación automática vía webhook, ver [ADR-024](./adrs/ADR-024-cobros-wompi-confirmacion-automatica.md) — decisión explícita del usuario de priorizarlo dentro de esta fase.
- [ ] Reactivación de leads fríos (12.3) explícitamente marcada como bloqueada hasta que exista una plantilla aprobada por Meta — no se implementa código de esta capacidad antes de tener la aprobación.
- [ ] Decisión explícita (no necesariamente en esta fase) de si se prioriza una fase futura para multimodalidad.
