# Fase 18 — Tickets y Conversaciones Accionables en el Panel

Estado: **en diseño** (v2)

Referencia: [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md#fase-18--tickets-y-conversaciones-accionables-en-el-panel) · [PROPUESTA_V2.md §3.5, §3.6](../../PROPUESTA_V2.md) · [Fase 11.2 — Conversaciones/Leads/Tickets](../fase-11-panel-admin-dashboard/conversaciones-leads-tickets.md) · [Fase 7 — Escalamiento a Humano](../fase-7-escalamiento-humano/README.md) · [Fase 13](../fase-13-identidad-roles-notificaciones/README.md)

Mueve la acción de tomar/resolver tickets del flujo por token de la Fase 7 a una sección del panel, y amplía la vista de Conversaciones de la Fase 11.2 con pausa puntual por conversación, acción de tomar ticket sin salir de la vista, y visualización legible en vez de JSON crudo.

## Relación con v1

- **Choca parcialmente con Fase 7**: [`vista-asesor.md`](../fase-7-escalamiento-humano/vista-asesor.md) y [`handoff-queue.md`](../fase-7-escalamiento-humano/handoff-queue.md) diseñaron deliberadamente un acceso simple por token (`GET /asesor/:token`, `POST /asesor/:token/tomar|resolver`) para "un equipo pequeño y confiable", documentando explícitamente que se revisaría "si el número de asesores o tenants crece". Con Fase 13 (login real) ya resuelta, esa condición de revisión se cumple — pero Fase 7 no queda tácitamente descartada: **ADR-028 decide explícitamente** si el flujo de token se retira o convive.
- **Extiende** [`conversaciones-leads-tickets.md`](../fase-11-panel-admin-dashboard/conversaciones-leads-tickets.md) (Fase 11.2), que dejó dicho de forma explícita: *"Reasignar o resolver tickets desde este listado — esas acciones ya existen en `POST /asesor/:token/tomar|resolver`; el listado de esta fase es de solo lectura/supervisión, no reemplaza el flujo del asesor"*. Esta fase es exactamente la extensión que ese texto dejaba pendiente.
- El reemplazo de JSON crudo por interfaz legible reutiliza el mismo dato ya expuesto por Fase 11.2 (`messages.tool_calls`) — no requiere ninguna tabla ni tool nueva, es presentación.

## Contenido de esta fase

- [adrs/ADR-028-convivencia-flujo-token-vs-panel.md](./adrs/ADR-028-convivencia-flujo-token-vs-panel.md) — decide y documenta la relación entre el flujo de token de Fase 7 y la acción desde el panel.

## Dependencias

**Fase 13** — la atribución "tomado por [nombre]" y el permiso `recibe_tickets` requieren el sistema de administradores.

## Riesgos

- Si ADR-028 decide retirar el flujo de token, hay que migrar cualquier enlace ya enviado y pendiente en producción (`handoff_tokens`, `migrations/0015`) antes de desactivarlo.
- Si decide que convivan, hay que resolver la condición de carrera de dos canales tomando el mismo ticket a la vez (mismo patrón `UNIQUE`/`ON CONFLICT` que ya usa `orders.idempotency_key`).

## Definición de terminado

- [ ] Un administrador puede tomar y cerrar un ticket completo desde el panel, con el cliente recibiendo la notificación de "te atiende [nombre]".
- [ ] La vista de detalle de conversación no muestra JSON crudo en ningún punto.
- [ ] Pausar el bot para una conversación puntual detiene las respuestas automáticas solo de esa conversación (columna `conversations.bot_paused`, mismo punto de chequeo que el kill-switch de tenant en `src/orchestrator/consumer.ts`).
- [ ] ADR-028 aceptada, con la decisión de convivencia/reemplazo ejecutada, no solo documentada.

Puede ejecutarse en paralelo con las Fases 14-17 y con las Fases 19 y 20 (no comparte esquema ni código base con ellas).
