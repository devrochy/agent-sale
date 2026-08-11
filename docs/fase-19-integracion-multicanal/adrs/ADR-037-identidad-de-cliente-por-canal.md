# ADR-037 — Identidad de cliente por canal

Estado: **aceptada e implementada** (Fase 19, Etapa C1). Prerequisito de las
Etapas C2 (Instagram) y C3 (Messenger): sin esto no hay dónde guardar un cliente
que no tenga teléfono.

## Contexto

`customers.phone_number` era `NOT NULL UNIQUE` y guardaba la dirección canónica
del canal (`whatsapp:+573184935933`), no un teléfono. La columna venía haciendo
dos trabajos a la vez y con WhatsApp como único canal la diferencia no se notaba.

Instagram y Messenger la rompen por los dos lados:

- Un **IGSID** (Instagram) y un **PSID** (Messenger) son identificadores opacos
  emitidos por Meta *por cuenta*. No son teléfonos y no hay API que los traduzca
  a uno.
- Son cadenas numéricas, igual que un `wa_id`. Con unicidad global por
  dirección, un IGSID podía colisionar con el teléfono de otra persona y
  fusionar dos humanos distintos en una fila. El caso ya está cubierto por un
  test de integración.

## Decisión de producto (definida por el usuario)

1. **Las conversaciones se llevan separadas por canal.** El mismo humano que
   escribe por WhatsApp y por Instagram son dos hilos.
2. **Interesa saber por dónde entró** cada conversación.
3. **No** hace falta deducir que dos identidades son la misma persona. Meta no
   da forma de saberlo, y adivinarlo tiene un modo de fallo caro: contestar por
   un canal al que el cliente nunca escribió.
4. **Pero si resulta ser el mismo cliente, sus datos sirven para gestionar el
   pedido.** No se le vuelve a pedir cédula y dirección a alguien que ya las dio.
5. **Se responde siempre por el canal por el que llegó el mensaje.**

## Decisión técnica

### `phone_number` se **renombra** a `external_id`

No se deja el nombre viejo con un significado nuevo. Renombrar es lo que hace
que el cambio falle ruidosamente: cualquiera de los ~60 puntos de uso que no se
migre deja de compilar contra la suite. Si se hubiera conservado el nombre, un
punto olvidado seguiría funcionando y mandaría el mensaje a una dirección mal
formada — una falla silenciosa, y la peor clase de falla acá, porque el síntoma
aparece días después como "a este cliente no le llegó nada".

### La unicidad pasa a `UNIQUE (channel, external_id)`

De "un teléfono en todo el sistema" a "una dirección dentro de su canal". El
mismo humano puede existir como dos filas, y eso es lo buscado: es lo que
implementa la decisión 1 sin ninguna lógica extra, porque las conversaciones
cuelgan del cliente.

`conversations.channel` ya existía desde la Etapa A y ahora queda determinado
por el canal del cliente, no por un `COALESCE` a `'whatsapp'`.

### `contact_phone`, nueva columna, nullable y **sin** `UNIQUE`

Es el teléfono de verdad, y es el único cruce entre canales que el sistema hace.

- Nullable porque un cliente que entra por Instagram no tiene teléfono hasta que
  lo da al comprar.
- Sin `UNIQUE` porque dos identidades de canal de la misma persona comparten
  teléfono de forma legítima — es justamente esa coincidencia la que habilita
  la decisión 4.
- Para WhatsApp se deriva de la dirección al crear el cliente, con la misma
  guarda (`LIKE 'whatsapp:+%'`) que el backfill de la migración `0054`. Sin esa
  guarda una dirección sin prefijo canónico se copiaría tal cual como si fuera
  un teléfono, inventando un cruce con otro cliente.

### El cruce vive en `crearPedido`, no en la resolución de conversación

`crearPedido` busca los datos de entrega en la fila propia y, solo si esa fila
no los tiene, en otra identidad con el mismo `contact_phone`. Es deliberado que
esté ahí y no antes: la conversación, el historial y el estado del bot **no** se
comparten entre canales; lo único que se comparte son los datos de gestión del
pedido.

El resultado sigue siendo `faltan_datos_cliente`. Encontrar los datos no
confirma nada — el modelo tiene que confirmárselos al cliente igual que con
cualquier dato guardado (ADR-033 de la Fase 15). Lo que evita es la fricción de
volver a pedirlos.

### `customer_data.phone`

Campo nuevo, opcional, en la tool `crear_pedido`. Aparece en `missing_fields`
solo cuando el cliente no tiene `contact_phone` — es decir, nunca por WhatsApp.
Por Instagram/Messenger hace falta de todos modos para coordinar la entrega, y
de paso es lo que forma el vínculo entre identidades para la próxima compra.

Se guarda con `save_permanently`, igual que el resto del perfil: el vínculo
entre canales no se arma sin que el cliente acepte que guardemos sus datos.

## Consecuencias

- El panel de Clientes muestra el canal pegado al nombre. Sin esa marca, dos
  filas del mismo humano se leen como duplicados de la base.
- La ventana de captura de la encuesta de satisfacción pasa a filtrar por canal:
  un "5" que entra por Instagram no puede calificar la conversación de WhatsApp
  que se cerró ayer.
- El campo del Redis Stream sigue llamándose `customer_phone` aunque el campo
  de TypeScript sea `customerExternalId`. Renombrarlo dejaría sin leer las
  entradas en vuelo, y además es la clave que `REDACT_PATHS` censura en los logs.
- El `down` de la migración `0054` **aborta con un error explícito** si hay
  clientes de Instagram o Messenger: el esquema anterior no puede
  representarlos, y borrarlos no es opción porque `conversations`, `orders`,
  `quotes`, `reviews` y `promotion_redemptions` los referencian.

## Alternativas descartadas

**Una fila de `customers` por persona, con las direcciones de canal en una tabla
aparte.** Es el modelo "correcto" de identidad, y es el que haría falta si
alguna vez quisiéramos unificar el historial. Se descartó porque la decisión de
producto es explícitamente la contraria (hilos separados), porque no hay ninguna
señal confiable para unificar, y porque obligaría a tocar las cinco tablas que
referencian `customers` en vez de una columna.

**Guardar el canal como prefijo dentro de `external_id` y no como columna.** Ya
pasa con `whatsapp:`, y es precisamente el patrón que causó el problema: mezcla
el dato con su interpretación y no se puede indexar ni restringir.
