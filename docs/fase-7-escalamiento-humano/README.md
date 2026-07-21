# Fase 7 — Escalamiento a Humano (Handoff)

Estado: **completada** (rama `feature/fase-7-escalamiento-humano`)

Referencia: [MASTER_PLAN.md](../../MASTER_PLAN.md#fase-7--escalamiento-a-humano-handoff) · [Fase 6 — Dominio Comercial](../fase-6-dominio-comercial/README.md)

Documentación de diseño, mismo criterio que las fases anteriores. Construye sobre la tool `escalar_a_humano` y las tablas `handoff_queue`/`human_agents` ya definidas en la Fase 1.

## Contenido de esta fase

- [reglas-escalamiento.md](./reglas-escalamiento.md) — máquina de estados con reglas explícitas (intentos fallidos, palabras clave, monto alto, solicitud directa, consulta técnica fuera de catálogo, refusal del modelo). El LLM puede sugerir escalar, pero no decide solo.
- [handoff-queue.md](./handoff-queue.md) — qué se escribe en `handoff_queue` y la decisión de notificar al asesor **reutilizando WhatsApp** (sin herramienta de soporte dedicada), consistente con el requisito de bajo costo.
- [vista-asesor.md](./vista-asesor.md) — página mínima de solo lectura con historial completo + estado estructurado; el asesor sigue respondiendo por WhatsApp, no por un chat embebido.

## Definición de terminado

- [x] Reglas explícitas de escalamiento definidas, con umbrales configurables por tenant (no hardcodeados).
- [x] `handoff_queue` diseñada con mecanismo de notificación real (WhatsApp vía Twilio, reutilizando infraestructura existente).
- [x] Vista mínima definida con todo el contexto necesario para que el asesor no le pida al cliente repetir información.
- [x] Reglas de reasignación/cierre definidas, incluyendo que la conversación no vuelve automáticamente al agente tras resolverse manualmente.

**Fase 7 completada, sin pendientes que bloqueen avanzar.** El umbral exacto de "monto alto" queda como propuesta inicial a validar con datos reales del piloto (Fase 9), no bloquea el diseño. Siguiente paso: Fase 8 — Observabilidad, Seguridad y Guardrails.
