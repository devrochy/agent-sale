# ADR-038 — Instagram Direct sobre el adapter de Meta

Estado: **aceptada e implementada** (Fase 19, Etapa C2). Depende de
[ADR-037](./ADR-037-identidad-de-cliente-por-canal.md), que creó la identidad
`(channel, external_id)` donde guardar un cliente sin teléfono.

## Contexto

[ADR-029](./ADR-029-arquitectura-gateway-multicanal.md) afirmaba que "un mismo
adapter de Meta atenderá los tres canales, porque Meta los sirve por el mismo
webhook y la misma API de envío". La mitad es cierta y la otra no, y la
diferencia define esta etapa:

- **El webhook sí es el mismo.** Instagram Direct llega a `/webhooks/meta`,
  desde la misma app, con el mismo App Secret y el mismo handshake. La firma
  es de la app, no del canal. Esa ruta no se tocó.
- **La API de envío no.** WhatsApp Cloud API es
  `POST /{phone_number_id}/messages` con `messaging_product`/`to`/`type`;
  Instagram Messaging es `POST /me/messages` con `recipient`/`message`, y
  devuelve el id en `message_id` en vez de `messages[0].id`.

Además, la cuenta de Instagram tiene que ser **profesional y estar vinculada a
una Página de Facebook**. Sin vincular, la API sería otra
(`graph.instagram.com`, con su propio login), y eso sí habría exigido un
adapter separado. Se eligió la ruta vinculada por eso.

## Decisión

### Un solo proveedor (`meta`), con despacho por canal adentro del adapter

No se agrega un proveedor nuevo ni se re-teclea el registry por
`(canal, proveedor)`. El motivo es concreto y no estético:

`inboundAdapterFor(provider)` se resuelve **antes** de conocer el canal. El
canal vive en la conexión, y la conexión se encuentra recién con la clave de
ruteo que el propio adapter extrae del payload. Un registry por canal para la
entrada no es que sea peor: es que no se puede.

El discriminador correcto lo trae el payload:

| | entrada | salida |
|---|---|---|
| qué se conoce | solo los bytes | la conexión completa |
| cómo se despacha | `payload.object` | `connection.channel` |

### `is_echo` se descarta, siempre

Meta reenvía por el mismo webhook los mensajes que mandó el **propio negocio**,
para que un CRM refleje lo que se respondió desde la app de Instagram.

Si no se filtran, el bot lee su propia respuesta como si fuera del cliente,
contesta, se vuelve a leer, y queda en un bucle contra una cuenta real —
gastando además la cuota de 200 mensajes automatizados por hora que Instagram
impone. Es el modo de fallo más caro de la etapa, y tiene test unitario y de
integración propios.

### El IGSID va verbatim a `external_id`

Sin prefijo. La identidad es `(channel, external_id)` desde ADR-037, así que
el canal ya lo lleva la columna de al lado; agregarle un `instagram:` sería
repetir el patrón que esa misma ADR documenta como descartado.

Instagram **no manda el nombre del perfil** con el mensaje, a diferencia de
WhatsApp: el cliente se crea sin nombre hasta que lo diga en la conversación.

### El timestamp de Instagram viene en milisegundos

El de WhatsApp viene en segundos, como string. Confundirlos no falla
ruidosamente: deja todas las fechas en 1970 y el mensaje se procesa igual, así
que el error aparecería mucho después y en la bandeja. Tiene test.

### La clave de ruteo la reporta Meta, no la tipea el admin

Para WhatsApp el admin tipea el Phone Number ID. Para Instagram la clave es el
**IGID** de la cuenta, que no es un dato que nadie tenga a mano. Lo deduce
`verifyCredentials` con `GET /me?fields=instagram_business_account{id,username}`
usando el token de Página, que de una sola llamada valida el token, el App
Secret (vía `appsecret_proof`) y —lo que más se rompe al configurar— que la
vinculación Página↔Instagram exista.

Por eso el error de "la Página no tiene una cuenta de Instagram vinculada" es
explícito y accionable: el token es válido, así que sin ese chequeo la conexión
se guardaría bien y simplemente no llegaría nunca un mensaje.

## Consecuencias

- Una imagen y su texto son **dos envíos** en Instagram: `message.attachment`
  no admite texto en el mismo mensaje. En WhatsApp van como imagen + caption en
  uno solo. Se devuelve el id del segundo, que es el que lleva la respuesta.
- `verifyCredentials` pasa a recibir el canal. Twilio no lo usa, y no necesitó
  cambios: un método con menos parámetros satisface el contrato igual.
- Los campos de credencial del panel dependen ahora del canal además del
  proveedor. La ruta de alta pasó a `/admin/conexiones/meta/:channel`, y
  `messenger` se rechaza explícitamente hasta la Etapa C3 — aceptarlo antes
  crearía una conexión que valida contra Meta pero que ningún webhook rutea.
- Instagram no manda `statuses[]`: las lecturas llegan por `messaging_seen`,
  que es otra suscripción y no dice nada sobre rechazos. `parseDeliveryStatuses`
  devuelve `[]`, y un fallo de envío se ve en el momento porque la llamada
  lanza.
- **Límite operativo:** 200 mensajes automatizados por hora por cuenta. Sobra
  para el piloto; hay que tenerlo en cuenta antes de abrir al público.

## Alternativas descartadas

**Un proveedor `instagram` separado.** Duplicaría la verificación de firma, el
handshake y el manejo de errores de la Graph API, que son idénticos, para no
duplicar dos endpoints. Y no resolvería la entrada, donde el problema no es
dónde vive el código sino que el canal todavía no se conoce.

**Registry por `(canal, proveedor)`.** Funcionaría para la salida y es
imposible para la entrada, por lo dicho arriba. Dejar los dos ejes despachando
distinto sería peor que despachar los dos adentro del adapter.
