# Log de Auditoría de Decisiones del Agente

Extiende la tabla `audit_log` ya definida en [modelo-datos.md](../fase-1-arquitectura/modelo-datos.md) (Fase 1) con el detalle de qué se registra y cuándo, durante la ejecución del orquestador ([orquestador.md](./orquestador.md)).

## Por qué es obligatorio, no opcional
Es el mecanismo principal para responder "¿por qué el agente cotizó esto?" o "¿por qué no escaló esta conversación?" sin tener que adivinar a partir del texto de la conversación. Dado que las tools ejecutan acciones de negocio reales (crear pedidos, aplicar descuentos), cada ejecución debe quedar trazada.

## Qué se registra, por evento

| Evento | `actor` | `action` | `input` | `output` |
|---|---|---|---|---|
| Cada tool ejecutada | `"tool"` | nombre de la tool (ej. `"aplicar_promocion"`) | los parámetros exactos que Claude propuso | el resultado real que devolvió la tool (validado contra Postgres) |
| Decisión de escalar | `"orchestrator"` | `"escalar_a_humano"` | motivo + resumen enviado al asesor | `handoff_id` generado |
| Turno completo (opcional, agregado) | `"agent"` | `"turno_conversacion"` | — | `stop_reason`, `usage` (incluyendo `cache_read_input_tokens` / `cache_creation_input_tokens`, ver [prompt-caching.md](./prompt-caching.md)) |

## Principio de diseño
El log registra **lo que la tool realmente hizo**, no lo que Claude dijo que iba a hacer — si Claude propone `aplicar_promocion` con un descuento del 20% pero la tool, al validar contra `promotions.rules`, solo aplica 10%, el `audit_log` refleja el 10% real. Esto es consistente con el principio "el LLM propone, la tool decide" (Fase 1): el log es la fuente de verdad de lo que pasó, no de lo que el modelo intentó.

## Relación con `messages.tool_calls`
La tabla `messages` (Fase 1) ya guarda qué tool se invocó en cada mensaje, como parte del historial conversacional. `audit_log` es complementario, no redundante: `messages.tool_calls` es para reconstruir la conversación (memoria), `audit_log` es para auditar decisiones de negocio (cumplimiento, debugging, confianza) — por eso `audit_log` incluye el detalle de validación (input propuesto vs. output real) que `messages` no necesita.

## Retención y acceso
No se define un período de retención específico en esta fase — es una decisión de negocio/legal, no de arquitectura técnica, y se documenta cuando se defina (probablemente en la Fase 8, junto con observabilidad y cumplimiento).

## Qué no cubre este documento
- Implementación real del logging (código) — fuera del alcance de este plan.
- Dashboard o interfaz de consulta del audit log — corresponde a la Fase 8 (Observabilidad).
