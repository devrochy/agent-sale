# ADR-002: Broker de colas de mensajes

## Estado
Aceptado.

## Contexto
Los mensajes entrantes de WhatsApp deben desacoplarse del procesamiento del agente para: (a) absorber picos de miles de conversaciones simultáneas sin perder mensajes, (b) permitir reintentos controlados, (c) no bloquear la respuesta al webhook del BSP (que espera un ACK rápido).

## Opciones consideradas
- **Kafka** — robusto y probado a gran escala, pero operacionalmente caro y complejo de mantener para el volumen inicial del proyecto (cientos de conversaciones/semana en el piloto).
- **Redis Streams** — liviano, ya se necesita Redis como caché de catálogo (ver [ADR-003](./ADR-003-estrategia-cache.md)), por lo que no agrega una pieza de infraestructura nueva.
- **SQS (o equivalente del proveedor de nube)** — gestionado, sin operación propia, pero acopla la plataforma a un proveedor de nube específico desde el inicio.

## Decisión
**Redis Streams.** Reutiliza la misma instancia de Redis que ya se necesita para caché, evita operar Kafka, y es suficiente para el volumen esperado del piloto y de la primera etapa de crecimiento.

## Consecuencias
- Un único componente de infraestructura (Redis) cumple dos roles: caché de catálogo y cola de mensajes — coherente con el requisito de bajo costo.
- Si el volumen crece más allá de lo que Redis Streams soporta cómodamente, la migración a SQS/Kafka queda documentada como decisión a revisar en la Fase 10 (Preparación para Escala), no antes.
