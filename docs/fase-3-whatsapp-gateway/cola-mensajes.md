# Diseño de la cola de mensajes

Extiende [ADR-002](../fase-1-arquitectura/adrs/ADR-002-broker-colas.md) (Redis Streams) con el diseño concreto para el flujo de WhatsApp.

## Stream

Un único stream `whatsapp:inbound`, con cada mensaje incluyendo `tenant_id` como campo — no un stream por tenant, para no multiplicar streams a medida que se agregan PyMEs (mismo principio de "no diseñar para hipotéticos" aplicado a la infraestructura).

## Esquema del mensaje encolado

```json
{
  "message_sid": "string — MessageSid de Twilio, ya validado como no-duplicado",
  "tenant_id": "uuid",
  "customer_phone": "string",
  "body": "string",
  "received_at": "timestamptz"
}
```

Nótese que el mensaje en la cola es deliberadamente mínimo — no incluye el historial de conversación ni contexto de negocio. Eso lo reconstruye el `orchestrator` al leer de Postgres, para que la cola no sea una fuente de verdad de estado, solo un canal de trabajo pendiente.

## Consumer group

Un consumer group `orchestrator-group`, con una o más instancias del `orchestrator` como consumidores — así, si se corre más de una instancia del monolito (para manejar más carga), ningún mensaje se procesa dos veces por consumidores distintos, y si una instancia cae a mitad de proceso, Redis Streams permite que otro consumidor reclame el mensaje pendiente (`XCLAIM`/`XAUTOCLAIM`).

## Reintentos y dead-letter

- Si el `orchestrator` falla al procesar un mensaje (ej. error llamando a Claude), el mensaje permanece "pending" en el stream y se reintenta automáticamente por el mecanismo de consumer group tras un timeout configurable.
- Tras **3 reintentos fallidos**, el mensaje se mueve a un stream `whatsapp:inbound:dead-letter` en vez de reintentarse indefinidamente, y se genera una alerta de observabilidad (Fase 8). Un mensaje en dead-letter significa que un cliente real de ForMotos no recibió respuesta — es el tipo de incidente que debe notificarse, no solo loguearse.

## Mensajes salientes

Las respuestas del agente hacia el cliente **no** pasan por esta misma cola de forma obligatoria — el `orchestrator` puede llamar directamente a la API de Twilio para enviar la respuesta, ya que es una operación síncrona simple (a diferencia de la recepción, que necesita desacoplarse del webhook). Se documenta como decisión abierta a revisar si en la práctica se necesita también encolar salientes (ej. para reintentos de envío) — no se sobre-diseña esto sin evidencia de que haga falta.

## Qué no cubre este documento
- Configuración real de Redis Streams (comandos, TTLs de stream) — implementación, no arquitectura.
