# Estrategia de idempotencia

## Por qué es necesaria
Twilio (como cualquier webhook de mensajería) puede reintentar la entrega de un evento si no recibe un `200 OK` a tiempo (timeout de red, deploy en curso, etc.). Sin control de duplicados, un mismo mensaje del cliente podría procesarse dos veces — en el peor caso, generando una cotización o pedido duplicado (ver riesgo ya identificado en el `MASTER_PLAN.md`, Fase 6).

## Clave de idempotencia
El `MessageSid` que Twilio asigna a cada mensaje es único y estable entre reintentos del mismo evento — es la clave natural de deduplicación en el `gateway` (antes de encolar).

## Mecanismo propuesto

1. Al recibir un webhook con firma válida, antes de encolar, el `gateway` verifica si `MessageSid` ya existe en un set de eventos procesados.
2. Implementación con Redis (ya presente en la arquitectura — ver [ADR-002](../fase-1-arquitectura/adrs/ADR-002-broker-colas.md)): `SET NX` sobre la clave `wa:processed:{MessageSid}` con un TTL de 48 horas (más que suficiente frente a la ventana de reintentos de Twilio, que es de minutos/horas, no días).
   - Si `SET NX` tiene éxito → es la primera vez que se ve este mensaje → se encola normalmente.
   - Si `SET NX` falla (la clave ya existe) → es un reintento → se responde `200 OK` sin volver a encolar.
3. Esta verificación ocurre **en el `gateway`, antes de la cola** — más barata y simple que deduplicar más abajo en el `orchestrator` o en la creación del pedido.

## Segunda capa: idempotencia en `crear_pedido`
La deduplicación por `MessageSid` cubre reintentos del webhook, pero no cubre el caso de que el propio LLM, por un error de razonamiento, intente llamar dos veces a la tool `crear_pedido` dentro de la misma conversación. Por eso el contrato de esa tool ([contratos-tools.md](../fase-1-arquitectura/contratos-tools.md), Fase 1) ya exige un `idempotency_key` propio a nivel de negocio, independiente del `MessageSid` del transporte. Son dos capas de protección distintas, cada una cubriendo un tipo de duplicado diferente.

## Qué pasa si Redis no está disponible
Si la verificación de idempotencia falla por caída de Redis, la decisión de diseño es **fallar cerrado hacia "no duplicar"**: si no se puede confirmar que el mensaje es nuevo, se prefiere no encolarlo y registrar un error de observabilidad, en vez de arriesgar un duplicado. Esto se revisita si en la práctica genera demasiados mensajes perdidos — por ahora prioriza evitar pedidos duplicados sobre no perder ningún mensaje.
