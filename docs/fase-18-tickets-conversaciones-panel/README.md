# Fase 18 — Tickets y Conversaciones Accionables en el Panel

Estado: **completa**

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

- [x] Un administrador puede tomar y cerrar un ticket completo desde el panel, con el cliente recibiendo la notificación de "te atiende [nombre]".
- [x] La vista de detalle de conversación no muestra JSON crudo en ningún punto.
- [x] Pausar el bot para una conversación puntual detiene las respuestas automáticas solo de esa conversación (columna `conversations.bot_paused`, mismo punto de chequeo que el kill-switch de tenant en `src/orchestrator/consumer.ts`).
- [x] ADR-028 aceptada, con la decisión de convivencia/reemplazo ejecutada, no solo documentada.

Puede ejecutarse en paralelo con las Fases 14-17 y con las Fases 19 y 20 (no comparte esquema ni código base con ellas).

## Ajustes posteriores (2026-08-05, tras pruebas manuales del usuario)

La implementación original cumplía la Definición de terminado, pero probarla end-to-end (tomar un ticket real y hablarle al bot por WhatsApp, navegar el rediseño de Conversaciones) encontró un bug real y varios ajustes de UX pedidos explícitamente. Todo esto se hizo sobre la misma rama, antes de abrir PR:

**Bug real — el bot seguía atendiendo al cliente después de escalar a humano.** Tomar un ticket (`tomarTicket`) no pausaba la conversación; el cliente seguía recibiendo respuestas automáticas mientras un administrador ya lo estaba atendiendo. Corregido: `tomarTicket` ahora hace `UPDATE conversations SET bot_paused = true` sobre la conversación del ticket (mismo kill-switch de `conversations.bot_paused` ya descrito arriba), y se reactiva únicamente desde `resolverTicket`/`reasignarTicketABot`. Mientras el ticket está `en_atencion`, el toggle de bot del detalle de conversación aparece bloqueado (no accionable) para que el administrador no lo reactive por error a mitad de un caso abierto.

**Composer de mensajes en el detalle de conversación.** Tomar un ticket redirigía a la conversación, pero no había forma de responderle al cliente sin salir del panel. Se agregó `enviarMensajeHumano` (`POST /admin/conversaciones/:conversationId/mensaje`): envía el mensaje por el mismo canal de WhatsApp que usa el bot y lo persiste con `sender_type: "human"`. Solo visible mientras el ticket está `en_atencion`. El botón "Enviar" lleva ícono + texto (antes solo texto).

**Rediseño de la sección Conversaciones** (`renderConversacionesPage`), a pedido explícito tras usar la vista real:
- El filtro por defecto al abrir la sección pasó de "Todas" a "Abiertas".
- Los tabs se reordenaron (Abiertas, Escaladas, Cerradas, Todas — antes Todas iba primero) y se colorearon (azul/rojo/verde/neutro).
- **Abiertas y Escaladas pasaron a ser mutuamente excluyentes.** El diseño original consideraba esto intencional (una conversación con ticket activo aparecía en ambos filtros); tras usarlo, se pidió lo contrario — el filtro Abiertas ahora excluye explícitamente cualquier conversación con un `handoff_queue` activo.
- Cada conversación (lista y detalle) muestra un único chip de estado con el mismo estilo: Abierta (azul), Escalada (rojo), Cerrada (verde).
- La caja fija de información del ticket en el detalle se reemplazó por un botón de ícono que abre esa información en una modal (mismo patrón `data-open-dialog` ya usado en Aliados/Productos); el estado del ticket y quién lo tomó se muestran como texto junto al chip de la conversación.
- Los botones de acción del ticket (tomar/resolver/reasignar al asistente) se reubicaron del renglón del teléfono a una columna a la derecha de la cabecera del detalle, debajo del toggle de bot — evita competir por espacio con el teléfono y con el ícono de ver ticket.

**Bug real — activar/desactivar el bot de una conversación puntual ignoraba el filtro activo.** El botón siempre redirigía a `estado=escaladas` sin importar desde qué tab se había accionado. Corregido con un parámetro `redirectQuery` opcional en `toggleSwitchHtml` (viaja como querystring en la URL del propio botón, ej. `/bot/desactivar?estado=abiertas`) — el mismo mecanismo sirve para cualquier futuro toggle que necesite "no cambiar de dónde estaba el admin".

Ninguno de estos ajustes cambia el alcance de la Definición de terminado original (sigue cumplida tal como está marcada arriba); son refinamientos de UX y una corrección de bug descubiertos al usar la feature con datos y flujo reales.
