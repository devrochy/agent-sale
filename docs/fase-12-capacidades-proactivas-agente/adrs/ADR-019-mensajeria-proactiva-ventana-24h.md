# ADR-019: Mensajería proactiva y la ventana de 24 horas de WhatsApp

## Estado
Aceptado.

## Contexto
Varias capacidades de [analisis-superpoderes.md](../analisis-superpoderes.md) implican que el sistema le escriba **primero** al cliente, sin que haya un mensaje entrante inmediatamente antes: Cazador de ventas (reenganchar a alguien que preguntó y se enfrió), Reactivación de leads fríos, Encuestas de satisfacción, solicitud de Reseñas. WhatsApp Business API impone una regla dura, independiente del BSP (Twilio en este caso): dentro de las **24 horas** desde el último mensaje del cliente, el negocio puede mandar mensajes de formato libre; **fuera** de esa ventana, solo puede mandar plantillas pre-aprobadas por Meta (`docs/fase-3-whatsapp-gateway/plantillas-mensajes.md` diseñó 3 plantillas para este caso en la Fase 3, pero **nunca se implementó** — confirmado en `mapeo-funcionalidades.md` de la Fase 11: "no soportado vía Twilio como está integrado hoy").

`src/gateway/sendMessage.ts` (`sendWhatsAppMessage`) ya es una función de envío saliente genérica, reutilizada hoy para notificar a un asesor humano en escalamientos (`src/domains/escalation/escalarHumano.ts:84-87`) — sirve como primitiva técnica para todo lo de esta ADR, pero no resuelve por sí sola el problema de la ventana de 24h.

## Decisión
**Clasificar cada capacidad proactiva según si su disparo cae dentro o fuera de la ventana de 24h, y solo construir lo que cae dentro hasta que exista aprobación real de plantillas de Meta:**

- **Dentro de la ventana (viable ahora, con `sendWhatsAppMessage` tal cual existe):**
  - Encuestas de satisfacción — se dispara al cerrar la conversación (`conversations.closed_at`), siempre dentro de las 24h desde el último mensaje del cliente.
  - Solicitud de Reseña — mismo momento que la encuesta, mismo argumento.
  - Cazador de ventas — el panel de referencia lo describe como reenganchar entre 3 y 20 horas después de que el cliente se enfrió; si el job (ver [ADR-018](./ADR-018-infraestructura-jobs-programados.md)) dispara dentro de esa ventana horaria, sigue siendo mensaje de formato libre, no plantilla.
- **Fuera de la ventana (bloqueado hasta tener plantillas aprobadas por Meta):**
  - Reactivación de leads fríos — por definición son leads que se enfriaron hace **días**, fuera de cualquier ventana de 24h. Requiere retomar el trabajo de `plantillas-mensajes.md` (Fase 3) y completarlo con aprobación real de Meta — un paso de negocio/compliance, no solo de código, con tiempo de espera no controlable (mismo riesgo que ya documentó la Fase 3 para la verificación de cuenta BSP).

Esta clasificación evita el error de diseñar (o peor, implementar) una función que en producción fallaría silenciosamente al intentar mandar un mensaje de formato libre fuera de la ventana permitida.

## Consecuencias
- Cazador de ventas, Encuestas y Reseñas se pueden especificar y construir sin depender de aprobación externa — quedan como candidatos de implementación más cercana en [analisis-superpoderes.md](../analisis-superpoderes.md).
- Reactivación de leads fríos queda marcada explícitamente como bloqueada por un paso externo (aprobación de plantillas de Meta), no por falta de diseño — si el negocio decide priorizarla, el primer paso es retomar `plantillas-mensajes.md` y gestionar la aprobación, no escribir código de reactivación todavía.
- Cualquier función de envío proactivo nueva debe validar en código que el último mensaje del cliente está dentro de las 24h antes de usar `sendWhatsAppMessage` en modo libre — si no lo está, debe fallar explícitamente (no intentar igual) hasta que exista soporte de plantillas.
