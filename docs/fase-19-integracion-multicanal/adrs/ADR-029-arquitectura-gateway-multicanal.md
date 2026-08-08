# ADR-029: Arquitectura de gateway multicanal (contrato genérico de adapter)

## Estado
Aceptada. La Etapa A (base de gateway + panel de conexiones) está implementada
y mergeada; ver "Estado de implementación" al final. Las Etapas B (WhatsApp por
Meta Cloud API) e Instagram/Messenger (C) quedan por delante sobre este mismo
contrato.

Esta ADR se corrigió al iniciar implementación en dos puntos que estaban mal
en la versión propuesta: el esquema de firma que usa el código hoy, y la
ausencia del eje de proveedor (ver más abajo).

## Contexto

`src/gateway/` era Twilio-específico: recepción de webhook, verificación de
firma, envío saliente (`sendMessage.ts`) y la ventana de 24h de WhatsApp
(ADR-019) estaban escritos asumiendo un único canal. `PROPUESTA_V2.md` §3.11
pide operar también sobre Instagram Direct y Facebook Messenger, con el canal
de origen visible en conversaciones/tickets (Fase 18).

**Corrección de un error de esta ADR:** la versión propuesta afirmaba que la
verificación de firma actual usaba `X-Hub-Signature-256`. Es falso — el código
usa (usaba) `X-Twilio-Signature`, HMAC-SHA1 sobre la URL más los parámetros
ordenados, vía `twilio.validateRequest`. `X-Hub-Signature-256` es el esquema de
**Meta**, HMAC-SHA256 sobre el cuerpo crudo, que esta fase todavía no
implementa (Etapa B). El mismo error ya lo había corregido
`docs/fase-3-whatsapp-gateway/webhook-contrato.md`.

**Segunda corrección: hacen falta dos ejes, no uno.** El contrato original
distinguía solo por canal. Pero WhatsApp puede servirse por Twilio *o* por Meta
Cloud API, y el usuario pidió explícitamente poder tener ambos disponibles y
elegir. Canal y proveedor son dimensiones independientes: el canal describe
dónde está el cliente, el proveedor describe por qué API se le habla.

## Opciones consideradas

1. **Duplicar el gateway completo por canal** (un `instagramGateway.ts`/`messengerGateway.ts` independiente, sin contrato compartido) — descartada: cada canal nuevo repetiría la lógica de idempotencia, cola de mensajes y resolución de tenant que ya existe para WhatsApp, con alto riesgo de que diverjan con el tiempo (ej. un fix de idempotencia en un canal y no en otro).
2. **Contrato de adapter genérico**, con WhatsApp como primera implementación migrada al mismo contrato — elegida.

## Decisión

### Contrato `ChannelAdapter` — indexado por proveedor, con dos pasos

```ts
interface InboundAdapter {
  provider: "twilio" | "meta";
  identifyConnection(raw): string | null;                 // clave de ruteo, NO confiable
  verifyRequest(credentials, raw): boolean;               // credencial como PARÁMETRO
  parseInbound(raw): NormalizedInbound[];                 // array: Meta manda lotes
}

type OutboundAdapter = PollingOutboundAdapter | WebhookOutboundAdapter;
```

Tres decisiones que la versión propuesta no contemplaba y que la implementación
obligó a fijar:

1. **Dos pasos para la firma, no uno.** Para verificar hace falta la
   credencial; para saber cuál es la credencial hace falta la conexión; y la
   conexión viene identificada *dentro del payload que todavía no se verificó*.
   `identifyConnection` extrae esa clave de ruteo con la advertencia explícita
   de que solo sirve para **buscar**, nunca para confiar. Para Twilio la clave
   es el campo `To`, que hasta ahora `webhookHandler.ts` leía y validaba sin
   usarlo nunca (resto de cuando resolvía el tenant).

2. **La credencial es un parámetro del adapter, no un lookup interno.** Es lo
   que mantiene los tests de verificación de firma como unitarios puros, sin
   base de datos, y lo que deja la resolución de la conexión en un solo lugar.

3. **El adapter se indexa por proveedor, no por canal.** Un mismo adapter de
   Meta atenderá WhatsApp, Instagram y Messenger, porque Meta los sirve por el
   mismo webhook y la misma API de envío. El canal vive en la conexión.

`parseInbound` devuelve un array y **un array vacío es un resultado normal**:
Meta usa el mismo endpoint para los callbacks de estado de entrega, que no
traen mensajes.

`sendMessage.ts` pasa a ser una fachada resolutora con dos entradas de
semántica distinta: `sendToConversation` (responde por la conexión por la que
entró el cliente) y `sendToPrimary` (lo que no tiene conversación —
notificaciones a administradores). La distinción no es estética: responder por
la conexión equivocada abre una ventana de 24h desde un número que el cliente
nunca contactó, el proveedor lo rechaza con el `63016`, y como el fallo es
asíncrono nadie se entera.

### `channel_connections`, `conversations.channel` y `connection_id`

Tabla nueva `channel_connections` con la matriz canal × proveedor. Dos detalles
de esquema que importan:

- **`UNIQUE(provider, external_id)`**, no `(channel, provider)`: la unicidad
  real es sobre la clave de ruteo entrante. La alternativa prohibiría dos
  números de Twilio (ventas y soporte, o el período de migración de un número
  a otro) y dos cuentas de Instagram.
- **Índice único parcial para `is_primary`**, no convención. El repo ya
  arrastra el singleton sin constraint de `settings`, con su baile de
  guardar/restaurar en los tests; no valía la pena repetirlo.

`conversations` gana `channel` (default `'whatsapp'`, sin backfill necesario) y
`connection_id`. Este último **sí** se backfillea, en `ensureConnectionsFromEnv`:
una conversación huérfana sin conexión haría que `recoverOrphanedConversations`
la reprograme, falle al resolver el adapter y lo reintente en cada arranque
para siempre.

### La clave de búsqueda de conversación no cambia en la Etapa A

`resolveConversation` **estampa** canal y conexión al crear, pero sigue
buscando "la conversación abierta más reciente del cliente", sin filtrar por
conexión. Mientras exista una sola conexión configurada, filtrar sería un
cambio de comportamiento con beneficio observable cero y riesgo alto: arrastra
los payloads de debounce en vuelo (`debounce:payload:*` no tiene TTL, así que
un despliegue dejaría mudas las conversaciones con un turno diferido), y un
bug real de atribución en `findPendingSurvey`, que busca por teléfono en todas
las conversaciones.

El cambio va en la Etapa B, junto con la decisión de producto que exige: qué
significa pausar un hilo, o resolver un ticket, cuando el mismo humano escribe
por dos conexiones distintas.

### Ventana de mensajería por canal

ADR-019 documentó la ventana de 24h específica de WhatsApp. Messenger/Instagram tienen su propia política (ventana estándar de 24h de Meta, con "etiquetas" para casos excepcionales — a confirmar contra la documentación vigente de Meta al iniciar implementación, puede haber cambiado). `isWithinMessagingWindow` se resuelve por adapter, no con una constante global — un canal no hereda por accidente la regla de otro.

### Modelo de entrega declarado, no inferido

`OutboundAdapter` es una **unión discriminada** por `deliveryModel`: Twilio es
`"poll"` (se consulta el estado por id), Meta será `"webhook"` (el estado
llega por el mismo endpoint entrante). Se eligió así en vez de un método
opcional porque el port natural de un opcional es
`if (!adapter.getDeliveryStatus) return`, que borraría en silencio el propósito
de `verifyDelivery.ts` — una función que nació de un hallazgo real de QA: el
rechazo `63016` por ventana de 24h vencida llega sin que el envío lance. Con la
unión, TypeScript obliga a estrechar antes de consultar.

### Credenciales en base de datos, configurables desde el panel

Corrige el alcance de la versión propuesta, que solo pedía credenciales por
tenant para los canales *nuevos*. Todas las credenciales, incluidas las de
Twilio, viven cifradas en `channel_connections.credentials_encrypted` (un blob
JSON con `secretBox.ts`, mismo primitivo que Wompi y el BYOK del LLM) y se
editan desde `/admin/conexiones` sin tocar `.env` ni reiniciar.

Un blob y no columnas por campo porque cada proveedor tiene los suyos —
Twilio `accountSid`/`authToken`, Meta `appSecret`/`accessToken`/`verifyToken` —
y así agregar un proveedor no migra el esquema.

Tres salvaguardas que la implementación obligó a agregar:

- **Caché en proceso con TTL corto e invalidación al guardar.** Sin ella, cada
  POST a la ruta pública del webhook haría una query más un descifrado AES-GCM
  *antes* de poder rechazar basura: un amplificador de DoS. Con ella, además,
  rotar una credencial desde el panel se refleja sin reiniciar.
- **`env` queda como fallback de la conexión de Twilio.** Sin esto, perder
  `TENANT_SECRETS_ENCRYPTION_KEY` pasaría de ser una degradación (key del LLM y
  Wompi) a un apagón total de WhatsApp. El descifrado falla suave y ruidoso, no
  lanza dentro del request.
- **`ensureConnectionsFromEnv` repara un canal sin primary.** El índice único
  parcial garantiza que no haya *dos*, pero no que exista *alguna*: basta
  borrar o reasignar la que la tenía para que se caigan todas las
  notificaciones a administradores, que son justo las que nadie mira cuando
  fallan.

`PUBLIC_WEBHOOK_URL` **sigue siendo requerida** aunque las credenciales de
Twilio ya no lo sean: además del webhook es el origen de los enlaces de asesor
(`escalarHumano.ts`) y de reseña (`satisfactionSurvey.ts`), así que un valor
vacío reventaría un `new URL("")` en mitad de una tool call.

### El formato de dirección canónico sigue siendo `whatsapp:+E164`

El prefijo `whatsapp:` es **sintaxis de transporte de Twilio**, y el adapter es
el único dueño de traducirlo: nada fuera del adapter puede asumirlo. Meta manda
`573184935933` (sin `+`, sin prefijo). Si el adapter de Meta normaliza mal en
la Etapa B, el mismo humano se parte en dos filas de `customers` y se rompen
historial de pedidos, `bot_paused` y datos de entrega.

Se evaluó migrar al canónico E.164 pelado y se descartó para esta etapa: el
costo (cuatro columnas más los helpers de `adminPanel.ts` y todos los fixtures)
se paga entero sin ninguno de los beneficios hasta que exista un canal que no
sea telefónico. El refactor real de identidad de `customers` (`external_id` +
`UNIQUE(channel, external_id)`) va en la Etapa C, cuando lleguen IGSID y PSID,
que no son teléfonos.

## Consecuencias

- Migrar WhatsApp al nuevo contrato es parte del alcance (no se deja como "adapter viejo + adapters nuevos incompatibles") — ya está hecho: `twilioSignature.ts` se retiró y el gateway no importa el SDK de Twilio fuera de `channels/twilio/`.
- El acoplamiento de WhatsApp a una única cuenta Twilio global (`plan-escalado-multi-cliente.md`) **queda resuelto en el envío**: el `from` sale de la conexión, no de `env.twilioWhatsappNumber`. Lo que sigue pendiente es lo multi-*tenant* (varios negocios en la misma instancia), que es otro problema.
- El panel (Fase 18) puede mostrar el canal de origen de cualquier conversación leyendo `conversations.channel`, sin lógica adicional. Todavía no lo hace: la columna en la bandeja queda para la Etapa B.
- El envío saliente tiene tests por primera vez. Antes `sendMessage.ts` se mockeaba entero en los 8 tests de integración, así que la construcción del payload no tenía ninguna red de seguridad — justo la superficie que este refactor reemplazó.
- Se cerró de paso un bug de UI reportado por el usuario: el riel decía siempre "Sin canal configurado" porque leía `settings.whatsapp_number`, columna huérfana desde ADR-032 que nadie escribe, mientras la página de Conexiones decía "Conectado". Eran dos fuentes de verdad; ahora ambas derivan de `channel_connections`.

## Estado de implementación

**Etapa A — completa.** Migración `0053`, `connectionsDirectory.ts`,
`src/gateway/channels/` (contrato + adapter de Twilio + registry), webhook
agnóstico de proveedor, cola con `connection_id`/`channel`, los 8 envíos al
cliente resueltos por conexión, y `/admin/conexiones` configurable.

**Pendiente, con su razón:**

- **Etapa B — WhatsApp por Meta Cloud API.** Adapter de Meta (handshake `GET`
  con `hub.challenge`, HMAC-SHA256 sobre el cuerpo crudo — el parser que lo
  conserva ya está, encapsulado en el plugin de webhooks), mapeo de direcciones
  con test dedicado, callback de estado (`value.statuses[]`), clave de búsqueda
  de conversación por conexión, fix de `findPendingSurvey`, decisión de producto
  sobre kill-switch y tickets con hilos paralelos, y columna de canal en la
  bandeja. Desbloquea la Fase 21.
- **Etapa C — Instagram y Messenger.** Refactor de identidad de `customers`.
  Requiere App Review de Meta para `pages_messaging` /
  `instagram_manage_messages`; en modo desarrollo solo se puede escribir a
  admins y testers de la app.
