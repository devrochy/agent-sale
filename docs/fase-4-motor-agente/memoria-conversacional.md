# Memoria Conversacional

Extiende el diseño de `conversations.state` y `messages` ya definido en [modelo-datos.md](../fase-1-arquitectura/modelo-datos.md) (Fase 1) con el detalle de cómo el orquestador lo usa en cada turno.

## Dos niveles de memoria

1. **Historial crudo** (`messages`, en Postgres) — cada mensaje entrante/saliente, tal como ocurrió. Es lo que se reconstruye como el array de `messages` que se envía a la API de Claude en cada llamada (la API es *stateless*: hay que reenviar el historial completo cada vez).
2. **Estado estructurado** (`conversations.state`, jsonb) — un resumen de "dónde va" la conversación, para que el agente (y un humano si escala) no tenga que releer todo el historial para saber el contexto de negocio.

## Qué guarda `conversations.state`

```json
{
  "step": "cotizando | esperando_confirmacion_pedido | resuelto | escalado",
  "productos_mencionados": [
    { "product_id": "uuid", "sku": "string", "cantidad_sugerida": 1 }
  ],
  "quote_id_activo": "uuid | null",
  "promocion_aplicada": "uuid | null"
}
```

Este estado se actualiza al final de cada turno, después de que el orquestador procesa la respuesta de Claude y el resultado de las tools ejecutadas — no lo escribe el modelo directamente, lo deriva el orquestador a partir de qué tools se llamaron (ej. si se llamó `generar_cotizacion`, `step` pasa a `"cotizando"` y se guarda el `quote_id_activo`).

## Construcción del array de `messages` en cada turno

1. Leer los últimos N mensajes de la conversación desde Postgres (N a definir en implementación; para conversaciones cortas de venta, probablemente no hace falta ningún límite — el contexto de 1M tokens de Sonnet 5 sobra para decenas de turnos).
2. Convertir cada mensaje guardado a su forma `MessageParam` (`role: "user" | "assistant"`, con los bloques de contenido correspondientes, incluyendo `tool_use`/`tool_result` si el turno tuvo llamadas a tools).
3. Anexar el mensaje nuevo del cliente al final.
4. Este array completo es el que se envía como `messages` en la llamada a Claude (ver [orquestador.md](./orquestador.md)).

## Por qué no compactación todavía

La API soporta compactación automática para conversaciones que se acercan al límite de contexto. **No se diseña esto para el MVP** — las conversaciones de venta de ForMotos son cortas (la Fase 0 estimó volumen y duración típica de una conversación de compra, no sesiones de horas), por lo que el contexto de 1M tokens de Sonnet 5 no debería llenarse en un caso de uso normal. Se deja como mejora documentada para la Fase 8 (Observabilidad) si en producción se observan conversaciones inusualmente largas.

## Relación con el escalamiento a humano

Cuando `escalar_a_humano` se ejecuta (Fase 1), el `conversation.state` completo (no solo el historial de texto) se adjunta al registro en `handoff_queue` (Fase 7) — así el asesor humano ve de inmediato en qué paso del flujo comercial estaba el cliente, no solo el texto de la conversación.

## Qué no cubre este documento
- El límite exacto de mensajes históricos a cargar por turno (N) — parámetro de afinación en implementación, no una decisión de arquitectura.
- Esquema de compactación — pospuesto, ver arriba.
