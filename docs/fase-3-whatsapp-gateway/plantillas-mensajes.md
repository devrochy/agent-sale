# Plantillas de mensajes pre-aprobadas

## Por qué se necesitan
Dentro de las 24 horas posteriores al último mensaje del cliente, el agente puede responder libremente con texto normal ("mensaje de servicio", gratuito — ver [ADR-001](../fase-1-arquitectura/adrs/ADR-001-bsp-whatsapp.md)). **Fuera** de esa ventana, WhatsApp solo permite enviar **plantillas pre-aprobadas por Meta** (categorías `utility`, `marketing`, `authentication`). Esto aplica, por ejemplo, a una actualización de pedido que llega horas después de la última respuesta del cliente, o a una promoción de temporada que la plataforma quiera enviar de forma proactiva.

## Plantillas necesarias para el caso de uso de ForMotos

| Plantilla | Categoría | Cuándo se usa | Contenido (variables) |
|---|---|---|---|
| `pedido_confirmado` | Utility | Al crear un pedido (tool `crear_pedido`), si la confirmación se envía fuera de la ventana de 24h | "Hola {{1}}, tu pedido #{{2}} por {{3}} fue confirmado. Método de entrega: {{4}}." |
| `pedido_en_camino` | Utility | Actualización de estado de envío (si ForMotos lo gestiona) | "Tu pedido #{{1}} de ForMotos está en camino." |
| `promocion_temporada` | Marketing | Envío proactivo de promoción de fin de año / día de celebridad (ver [Fase 0](../fase-0-descubrimiento.md), sección de promociones) | "¡{{1}} en ForMotos! {{2}}% de descuento en {{3}} hasta el {{4}}." |

Las plantillas de **marketing** tienen un estándar de aprobación más estricto que las de **utility** (Meta es más cuidadoso con contenido promocional no solicitado) — se debe esperar más fricción/tiempo de aprobación en `promocion_temporada` que en las otras dos.

## Proceso de aprobación
1. Se registran en la consola de Twilio (que las sincroniza con el sistema de plantillas de Meta) — parte del [checklist de cuenta BSP](./checklist-cuenta-bsp.md).
2. Meta revisa el texto contra sus políticas de contenido — puede aprobar, rechazar, o pedir cambios.
3. Una vez aprobada, la plantilla se identifica por nombre + idioma; el `orchestrator` la invoca por ese identificador, no por texto libre.

## Regla de diseño para el agente
El agente (Claude) **nunca decide el texto exacto de una plantilla** — solo decide *cuándo* correspondería enviarla (ej. "esta conversación lleva más de 24h inactiva y hay que notificar el pedido") y con qué variables. El texto en sí está fijo y aprobado, coherente con el principio general de "el LLM propone, la tool decide" (Fase 1).

## Qué no cubre este documento
- El registro real de las plantillas en Twilio/Meta — acción manual, parte del checklist.
- Plantillas adicionales que puedan necesitarse más adelante (ej. recordatorio de carrito abandonado) — se agregan cuando haya un caso de uso validado, no de forma especulativa.
