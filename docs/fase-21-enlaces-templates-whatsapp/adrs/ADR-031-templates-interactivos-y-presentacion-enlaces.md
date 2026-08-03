# ADR-031: Templates interactivos de WhatsApp para cierre de pedido y presentación de enlaces como hipervínculo

## Estado
Propuesta (pendiente de aceptación antes de iniciar implementación de la Fase 21).

## Contexto

`extractPaymentLinkUrl` (ADR-024) hoy anexa la URL completa de pago al `responseText` final como texto plano, después de los guardrails de precio/stock y antes del split de burbujas (`messageSplitter.ts`). `src/reviews/reviewView.ts` (Fase 12.2) genera un enlace de reseña con el mismo criterio. `PROPUESTA_V2.md` §3.9 pide dos cambios de naturaleza distinta: presentación de enlaces (transversal, bajo esfuerzo) y templates de botones para cierre de pedido (requiere aprobación de Meta, mismo mecanismo que ya bloquea a la Fase 12.3).

## Opciones consideradas

### Presentación de enlaces

1. **WhatsApp Cloud API/Twilio no soportan Markdown de hipervínculo con texto propio en mensajes de texto plano** (a diferencia de HTML) — verificar contra la documentación vigente de la API al iniciar implementación, dado que el formato de mensajería de WhatsApp es más limitado que HTML. Si el canal no soporta texto de enlace personalizado, la alternativa realista es un mensaje interactivo de tipo "botón de URL" (`cta_url` en Meta Cloud API / mensaje de plantilla con botón de enlace en Twilio) en vez de un hipervínculo inline.
2. **Mensaje de texto con negrita/formato WhatsApp nativo alrededor del enlace** (`*Paga aquí:* <url>`) — degrada a mostrar igual la URL cruda, no resuelve el pedido real de "nunca la URL completa".

Dado que la opción 1 requiere confirmar límites reales de la API antes de comprometer el diseño exacto, esta ADR fija el objetivo (nunca URL cruda visible) y dos rutas posibles según lo que confirme la implementación: botón de URL nativo si el canal lo soporta, o mensaje de plantilla con botón si no.

### Cierre de pedido

1. **Texto libre con opciones numeradas** ("1. Confirmar pedido, 2. Agregar más, 3. Cancelar") — comportamiento actual, no requiere aprobación de Meta pero es exactamente lo que `PROPUESTA_V2.md` pide reemplazar.
2. **Plantilla de WhatsApp con botones de respuesta rápida** (`quick_reply` / `interactive buttons`) — elegida, requiere aprobación de Meta como cualquier plantilla nueva (mismo mecanismo de ADR-019).

## Decisión

### Enlaces como botón de URL (no hipervínculo de texto inline)

Todo enlace saliente generado por el asistente (`extractPaymentLinkUrl`, enlace de reseña) se envía como mensaje con botón de acción (`"Paga aquí"`, `"Déjanos tu reseña"`) apuntando a la URL, en vez de concatenar la URL al texto de respuesta. Esto es un cambio de forma de envío (`sendMessage.ts`/adapter de canal, ver Fase 19), no de dónde se genera la URL — `extractPaymentLinkUrl` sigue siendo la única fuente de verdad de la URL real, solo cambia cómo se empaqueta el mensaje saliente.

### Template de botones para cierre de pedido, con fallback a texto libre

Plantilla nueva con 3 botones de respuesta rápida ("Quiero hacer mi pedido" / "Agregar más productos" / "Cancelar mi pedido"), sometida al mismo trámite de aprobación de Meta que cualquier plantilla de ADR-019. Mientras la plantilla no esté aprobada (o si Meta la rechaza), el flujo usa el texto libre actual sin bloquear el cierre de pedido — mismo principio que ya aplica la Fase 12.3 (no construir sobre una plantilla no aprobada como si ya lo estuviera).

### Extensión a la confirmación de datos de cliente (Fase 15)

El mismo mecanismo de botones de respuesta rápida se reutiliza para la confirmación binaria de datos de cliente ("¿los datos siguen siendo los mismos?" / "Quiero cambiarlos") de la Fase 15 — una sola plantilla de "confirmación binaria" genérica, reutilizable en más de un punto del flujo, en vez de una plantilla dedicada por caso de uso.

## Consecuencias

- El tiempo de aprobación de Meta para la plantilla de botones es no controlable — la Fase 21 no se bloquea por esto (fallback a texto libre), pero el "camino feliz" con botones reales depende de un trámite externo, igual que ya documentó Fase 3 para la cuenta BSP.
- El formato final exacto de "botón de URL" queda sujeto a lo que confirme la implementación contra la API vigente de WhatsApp (Cloud API directa o vía Twilio) — esta ADR fija el objetivo de producto (nunca URL cruda), no un payload JSON específico que podría quedar desactualizado frente a cambios de la API de Meta.
- Reutilizar una plantilla de confirmación binaria genérica entre Fase 15 y Fase 21 reduce el número de plantillas que hay que someter a aprobación de Meta.
