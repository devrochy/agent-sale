# ADR-033: Meta Cloud API como segundo proveedor de WhatsApp

## Estado

Aceptada. Implementada en la Etapa B de la Fase 19. Extiende
[ADR-029](./ADR-029-arquitectura-gateway-multicanal.md), que fijó el contrato de
adapters con dos ejes (canal y proveedor); esta ADR resuelve las decisiones que
solo aparecieron al escribir el segundo proveedor.

## Contexto

La Etapa A dejó el gateway sobre una matriz canal × proveedor con Twilio como
única implementación. Un contrato con una sola implementación no está probado:
esta etapa es la primera que lo ejercita de verdad.

El disparador concreto fue la Fase 21: el sandbox de Twilio no admite content
templates propios, así que los botones interactivos no se pueden probar ahí.
Meta sí los permite dentro de la ventana de 24 h, sin aprobación.

## Decisiones

### El formato canónico de dirección no cambia, y el adapter lo traduce

El sistema guarda `whatsapp:+E164` (regla de ADR-029). Meta manda y recibe el
`wa_id` en dígitos pelados: `573184935933`.

`channels/meta/addresses.ts` es el único punto que traduce, y la regla es
**round-trip verbatim del `wa_id`, sin normalizarlo**:

- Para algunos países el `wa_id` no coincide con el número que uno marcaría
  (México antepone un `1`, Argentina un `9`). "Arreglarlo" a un E.164 real haría
  que la respuesta no llegue.
- Si la traducción no round-trippea, el mismo humano se convierte en **dos filas
  de `customers`** —una por Twilio, otra por Meta— y se parten historial de
  pedidos, `bot_paused`, datos de entrega y segmentación.

Se evaluó migrar el canónico a E.164 pelado y se descartó: el costo (cuatro
columnas, los helpers del panel y todos los fixtures) se paga entero sin
beneficio hasta que exista un canal que no sea telefónico. Eso llega con
Instagram y Messenger, en la Etapa C.

### Un cliente, una conversación, que sigue al último número usado

Decisión de producto del negocio. Si el mismo humano escribe al número de
Twilio y al de Meta:

- Es **el mismo hilo**: conserva carrito, historial y estado de pedido. La
  bandeja no muestra filas duplicadas del mismo cliente.
- Pero `conversations.connection_id` **se actualiza en cada mensaje entrante**.
  Sin eso le responderíamos desde un número que nunca contactó, lo que abre una
  ventana de 24 h nueva que el proveedor rechaza — y el fallo es asíncrono, así
  que nadie se entera.

La clave de búsqueda de `resolveConversation` sigue siendo "la abierta más
reciente del cliente", sin filtrar por conexión: eso *es* la implementación de
esta decisión.

**Consecuencia útil:** disuelve un pendiente que la Etapa A había anotado. El
bug de atribución de `findPendingSurvey` —que busca la encuesta por teléfono
entre todas las conversaciones— solo existía si hubiera hilos por conexión. Con
un hilo por cliente no hay ambigüedad y no hay nada que arreglar.

### Estados de entrega por webhook, declarados por capacidad

Meta no admite consultar la entrega por id: la notifica por el mismo endpoint
entrante, en `value.statuses[]`. El contrato ya lo contemplaba con la unión
discriminada `deliveryModel`, así que `verifyDelivery` no consulta nada para
Meta.

Se agrega `parseDeliveryStatuses?()` **opcional** al adapter de entrada (Twilio
no lo implementa), y el handler loguea los `failed` con su código de error. Es
la señal equivalente al `63016` de Twilio: sin ella, un mensaje rechazado por
ventana de 24 h vencida se perdería en silencio — exactamente el hallazgo de QA
que originó `verifyDelivery.ts`.

No se persisten ids de mensaje: correlacionar cada estado con su conversación es
un cambio mayor y no hace falta para tener la señal.

### El handshake se valida contra cualquier conexión de Meta

El `GET` de verificación de Meta no dice a qué conexión corresponde. Se compara
el `hub.verify_token` contra el de todas las conexiones de Meta configuradas —
son pocas, y el token es precisamente lo que prueba que quien pregunta configuró
alguna de ellas.

### Sin SDK para la Graph API

Son tres llamadas HTTP con JSON; una dependencia no se paga. Detalle que sí
importa: **la Graph API señala fallas con un objeto `error` en el body y no
siempre acompaña con un status HTTP de error**, así que se chequean las dos
cosas.

Versión fijada en `v25.0` (publicada en febrero de 2026, vigente hasta julio de
2028): se eligió sobre la última, `v26.0`, por madurez, y sobre las anteriores
por vida útil restante.

## Consecuencias

- **El token del número de prueba de Meta caduca cada 24 h.** Es cómo funciona
  el modo desarrollo, no un defecto: la conexión deja de enviar cada día hasta
  que se pega uno nuevo en el panel. Un token permanente exige registrar un
  número propio con un System User token.
- El modo desarrollo limita a **5 destinatarios de prueba**, dados de alta en la
  app de Meta. No sirve para un piloto con clientes reales.
- La bandeja muestra el canal **y el proveedor**: con WhatsApp entrando por dos
  vías, saber por cuál llegó importa para diagnosticar.
- El contrato de ADR-029 aguantó el segundo proveedor sin cambios estructurales.
  Lo único que se agregó fue `parseDeliveryStatuses` opcional, y la separación
  `external_id` / `display_address` —que en la Etapa A podía parecer sobrediseño
  con un solo proveedor— resultó ser exactamente lo que Meta necesitaba: su
  clave de ruteo es el `phone_number_id`, que no es un teléfono.
- El adapter se escribió contra documentación, no contra tráfico real. La
  verificación de punta a punta con el número de prueba es lo que cierra la
  etapa.
