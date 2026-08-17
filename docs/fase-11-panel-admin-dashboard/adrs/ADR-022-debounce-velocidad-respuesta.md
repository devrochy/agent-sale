# ADR-022: Debounce de mensajes seguidos (Velocidad de respuesta)

## Estado

Aceptado.

## Contexto

Al continuar parametrizando la sección "Configuración" del panel de referencia Forja, el usuario pidió **Velocidad de respuesta** (Rápido 5s/Normal 15s/Pausado 30s): cuánto espera el bot antes de procesar un mensaje, para agrupar mensajes seguidos del mismo cliente en un solo turno de respuesta en vez de responder fragmento por fragmento.

Hoy (antes de esta ADR) cada mensaje entrante se procesa de inmediato: `src/orchestrator/consumer.ts` lee una entrada de `whatsapp:inbound` (Redis Streams) y dispara `runTurn` sin ningún retraso. Esto **no era una decisión documentada en ninguna ADR** — era simplemente el único comportamiento que existía, nunca se necesitó agregar un debounce hasta ahora. Esta ADR no revierte nada; documenta un mecanismo nuevo.

## Opciones consideradas

- **Delay fijo con `setTimeout` en el propio consumer**: simple, pero no sobrevive un restart del proceso (el timer vive en memoria) y no da forma de "reiniciar" el timer si llega un segundo mensaje sin duplicar lógica.
- **Cola de jobs con delay (ej. BullMQ)**: agrega una dependencia nueva completa solo para este caso de uso — desproporcionado para el volumen del piloto.
- **Redis Sorted Set como cola de espera**, elegida: mismo principio que usan colas con delay reales (Sidekiq, BullMQ) pero sin librería nueva — ya hay una instancia de Redis en el proyecto (Streams, idempotencia). `ZADD` sobre un member existente actualiza su score: un mensaje nuevo de la misma conversación "reinicia el timer" gratis, sin lógica adicional de cancelar-y-reprogramar.

## Decisión

### Mecanismo: `debounce:pending` (Sorted Set) + `debounce:payload:<conversationId>`

`src/orchestrator/debounceScheduler.ts`. Cada mensaje entrante hace `ZADD debounce:pending <now + delayMs> <conversationId>` — el `member` es siempre `conversationId` (nunca cambia), así que un mensaje nuevo de la misma conversación reprograma en vez de crear una entrada paralela. El payload (`tenantId`, `customerPhone`, `messageSid`, `customerName`) vive en una clave de texto aparte (`debounce:payload:<conversationId>`), porque el member del sorted set tiene que ser estable — si el payload viviera codificado en el member, cada mensaje nuevo (con un `messageSid` distinto) crearía una entrada nueva en vez de reprogramar la existente.

Un segundo loop de polling (cada 1.5s) hace `ZRANGEBYSCORE debounce:pending -inf <now>` para encontrar candidatos vencidos, y por **cada candidato individualmente** hace `ZREM` — solo si devuelve 1 (ganó el claim) dispara el turno. Evita el TOCTOU de leer-en-batch-y-remover-en-batch si en algún momento corre más de una réplica del proceso sobre el mismo Redis (hoy es 1 réplica, pero el costo de hacerlo bien es cero).

### Split de `loop.ts`: `appendInbound` + `processConversation`

Necesario porque `runTurn` (antes de esta ADR) hacía guardado + procesamiento en una sola llamada atada a un `incomingBody`/`messageSid` puntual — el debounce necesita separar "guardar ya" de "procesar más tarde":

- **`appendInbound`**: se llama siempre, de inmediato, por cada mensaje — nunca se difiere. Guarda el mensaje y corre las dos reglas que **no pueden esperar** a que venza la ventana: el estado ya escalado, y el backstop de palabras clave (`matchKeywordEscalation`) — si un mensaje intermedio dentro de la ventana matchea una keyword, escala de inmediato y cancela cualquier timer pendiente (`cancelDebounce`), sin esperar a que llegue el "último" mensaje de la ventana que podría taparla.
- **`processConversation`**: el resto de lo que hacía `runTurn` — arranca desde `resolveConversation`/`loadHistory` de nuevo (no desde el mensaje puntual), así que ve el estado y el historial más recientes, incluyendo todos los mensajes acumulados durante la espera. `messageSid` usado para el idempotency_key de `crear_pedido` es el del último mensaje que (re)armó el timer.
- **`runTurn`** se conserva como wrapper de conveniencia (`appendInbound` + `processConversation` en la misma llamada) para el caso `"inmediato"` (default) — firma y comportamiento idénticos a los de antes de esta ADR, cero regresión. Los 7 tests existentes de `loop.test.ts` siguen pasando sin modificarlos.

### Envío de la respuesta: `sendTurnResult.ts`

El envío por burbujas (`splitForBubbles` + reintento por burbuja, ver ADR-021) se extrajo de `consumer.ts` a `src/orchestrator/sendTurnResult.ts` (`sendTurnBubbles`) porque ahora hay **dos** callers que necesitan enviar un `TurnResult`: `consumer.ts` (turno inmediato o escalado en ingesta) y `debounceScheduler.ts` (turno diferido, disparado por el poller, sin una entrada de Redis Stream detrás).

### Recuperación de crash a mitad de ventana

El mensaje del cliente nunca se pierde (ya está en Postgres desde `appendInbound`, antes de programar cualquier timer) — pero si el proceso muere con un timer en el aire, el **disparo** sí se pierde, y sin recuperación la conversación queda colgada indefinidamente (no es una demora acotada, es un cuelgue real hasta que el cliente vuelva a escribir). Al arrancar, `debounceScheduler` hace un barrido único: conversaciones abiertas, no escaladas, de tenants no pausados, cuyo último mensaje es inbound (el cliente — o una `tool_result` intermedia — está esperando algo que nunca llegó) y sin un timer vivo en `debounce:pending`, se reprograman con `score=now` (no hacen esperar la ventana completa de nuevo, ya esperaron bastante con el crash).

### Default: `"inmediato"`, no `"rapido"`

`behaviorConfig.velocidadRespuesta` usa un 4to valor `"inmediato"` (sin entrada en `DEBOUNCE_DELAY_MS`) como default — deliberadamente no se reutiliza `"rapido"` (5s) como default, porque hasta "rápido" ya es más lento que el comportamiento de hoy. Con `"inmediato"`, `runTurn` corre exactamente como antes de esta ADR, sin tocar el Sorted Set.

## Consecuencias

- **Límite conocido, no resuelto por esta ADR**: si `processConversation` o el envío fallan cuando el timer vence (`fireConversation` en `debounceScheduler.ts`), no hay backing de Redis Streams para reintentar automáticamente (el mensaje original ya se hizo `XACK` al ingerirse) — se loguea el error y no se reintenta solo. El mensaje del cliente sigue guardado y visible en el inbox de Conversaciones; el barrido de recuperación del próximo arranque lo detectaría si el proceso se reinicia, pero un fallo transitorio sin restart queda sin reintento automático. Aceptable para el volumen actual del piloto — revisar si se observan fallos reales en producción.
- `matchKeywordEscalation` corre en **cada** mensaje individual durante la ventana (no solo en el que la dispara), a diferencia de antes donde corría una vez por `runTurn`. Es más chequeos (uno por mensaje en vez de uno por turno), pero cada uno es una comparación de substring barata — sin impacto de costo real.
- `resolveConversation` se llama dos veces por turno completo (`appendInbound` + `processConversation`) en vez de una — una consulta indexada extra, aceptada por simplicidad (evita pasar el objeto de conversación completo entre funciones).
- No cambia nada del contrato con Twilio/webhook — el debounce vive enteramente del lado del orquestador, después de que el webhook ya respondió 200 y encoló el mensaje.
