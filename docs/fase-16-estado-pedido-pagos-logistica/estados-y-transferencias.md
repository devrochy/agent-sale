# Estados del pedido, transferencias y rechazos de pago

Cinco cambios que se sostienen entre sí: el pedido pasa a tener estados
reales, el rechazo de un pago deja de perderse, el enlace de Wompi se guarda,
el asistente manda los datos de transferencia, y la tabla de Pedidos se
puede recorrer.

## Dos ejes, no uno

Los estados que se piden mezclan dos ciclos distintos: *abierto* y
*despachado* son del pedido; *pendiente de pago*, *pagado* y *rechazado* son
del pago. La tabla ya los tenía separados en `status` y `payment_status`, y
**separados se quedan**: un pedido puede estar pagado y sin despachar, o
despachado y sin pagar (contraentrega). Fundirlos en una columna obligaría a
inventar estados combinados —`pagado_despachado`— que se multiplican solos.

La base guarda los dos hechos; el panel muestra **uno derivado**, que es lo
que se quiere leer de un vistazo. `derivarEstado()` es el único lugar que
sabe combinarlos.

| `status` | `payment_status` | Se lee |
| --- | --- | --- |
| abierto | pendiente | Pendiente de pago |
| abierto | pagado | Pagado |
| despachado | cualquiera | Despachado |
| despachado | rechazado | **Pago rechazado** |
| entregado | cualquiera | Entregado |
| cancelado / expirado | cualquiera | Cancelado / Vencido |

**El orden de las ramas es la regla de negocio.** Lo terminal gana sobre lo
transitorio: un pedido cancelado con el pago pendiente ya no espera ningún
pago. Y el rechazo pisa a *despachado* a propósito — un pedido que salió y
cuyo pago rebotó es exactamente el que hay que mirar primero; verlo como
"Despachado" lo escondería.

No existe un estado *abierto* visible: por sí solo no dice nada accionable.

### Lo que ya no se puede escribir

`status` **nunca tuvo CHECK**: se escribía `'abierto'` desde `crearPedido.ts`
y `'expirado'` desde `closeExpiredOrders.ts`, sin nada que impidiera un typo.
Ahora lo tiene, y eso destapó dos cosas que la migración arregla:

- **Filas con `'confirmed'`**, el default histórico de la columna, anteriores
  a la Fase 15.
- **El DEFAULT de la columna seguía siendo `'confirmed'`**, así que cualquier
  `INSERT` que no nombrara `status` habría reventado contra el CHECK nuevo.
  `crearPedido.ts` sí la nombra y por eso la app no lo notaba: lo encontró un
  fixture de test que insertaba sin ella.

También hay backfill de despacho: un pedido con guía registrada ya salió, y
hasta ahora eso solo vivía en `shipped_at` mientras `status` se quedaba en
`'abierto'`. Con el estado visible en el panel, esas filas mentirían.

Registrar la guía **es** el despacho, y por eso mueve el estado en el mismo
`UPDATE` que escribe el tracking: así no hay forma de tener guía sin
despachar. *Entregado* y *cancelado* siguen siendo decisión de un humano —
son las dos transiciones que ningún sistema puede detectar solo.

## El rechazo de pago que se perdía

El webhook de Wompi ya existía, ya validaba checksum y ya marcaba los pagos
aprobados. Lo que hacía con `DECLINED` era **descartarlo con un log**: el
pedido se quedaba "pendiente de pago" hasta que el job de los cinco días lo
vencía, y nadie se enteraba de que el pago había rebotado hoy.

Ahora `DECLINED`, `VOIDED` y `ERROR` marcan `payment_status = 'rechazado'`,
guardan el motivo en `status_reason` y avisan a los admins con
`recibeNotificacionPagos`. `PENDING` se sigue ignorando a propósito: es
transitorio —PSE, sobre todo— y Wompi manda otro evento al resolver.

El guard sigue siendo `payment_status = 'pendiente'`: un pago ya confirmado
no se revierte por un webhook que llega tarde y desordenado.

## El enlace de pago

Se generaba, se le mandaba al cliente por WhatsApp y **se perdía**: solo se
guardaba el id del link. Sin la URL el panel no puede reabrirla ni
reenviarla, que es justo lo que hace falta cuando el cliente dice "no me
llegó". Ahora se guarda en `orders.wompi_payment_link_url` y aparece en la
celda de Pago **mientras sirve de algo** — un pedido ya pagado o rechazado no
se paga de nuevo con ese enlace.

## Datos de transferencia

Antes no existía nada: ni configuración ni envío. Se cargan en
**Configuración → Cobros** (entidad, tipo, número, titular, documento, y si
está activa) y se guardan en `settings.transfer_accounts` como jsonb — mismo
criterio que `brand_voice_config`: configuración de un singleton que se lee
entera y se reescribe entera, donde una tabla propia agregaría un CRUD y dos
joins para guardar cuatro líneas de texto.

### El mensaje no pasa por el LLM

**Ésta es la decisión central.** Todo lo demás que el cliente recibe lo
redacta el modelo a partir del output de las tools. Un número de cuenta, no.

Un dígito alucinado o "corregido" manda la plata de alguien a una cuenta
ajena y, a diferencia de un enlace roto —que falla ruidosamente—, **una
cuenta equivocada parece funcionar** hasta que el dinero no llega.

Por eso `enviarDatosTransferencia()` arma el texto con los valores tal como
están guardados y lo manda como mensaje aparte. Al LLM le llega solo
`transfer_details_sent: true`, y el prompt le prohíbe explícitamente escribir
un número de cuenta "ni siquiera si lo vio antes en la conversación".

Sin ninguna cuenta activa el asistente no puede dar datos de pago: devuelve
`false` y el prompt le indica escalar a un humano. Configuración lo avisa en
la propia sección.

### Por qué el estado va en un `<select>`

Las filas del formulario viajan como arrays (`entity[]`, `accountNumber[]`…)
y se recomponen por posición. Un checkbox desmarcado **no se envía**, así que
`active` llegaría más corto que el resto y las filas se desfasarían entre sí
—la cuenta 2 heredaría el estado de la 3—. Un `<select>` siempre manda valor.

## La tabla de Pedidos

Pasó de 9 columnas sin filtros a 8 con tres filtros (estado, pago, entrega),
orden por columna y paginado.

- **Los items dejan de ser una columna gorda** de texto envuelto y pasan a la
  fila expandible que Productos ya usa para sus variantes. El disparador va
  pegado al número de pedido —expandir *es* abrir ese pedido— y no en una
  columna propia: diez columnas no entraban sin scroll horizontal.
- **La dirección sale de la celda de Items**, donde estaba apretada, y pasa a
  un diálogo detrás de "Ver dirección": son cinco campos que no entran en una
  celda y que solo hacen falta al despachar.
- **La guía se muda a la columna Entrega.** Junta con el método y la
  dirección se lee como "cómo le llega esto al cliente", que es la pregunta
  real.
- **Los métodos de pago se muestran con su nombre.** `efectivo_contraentrega`
  es la clave que usa la tool y en una tabla se lee como una variable.
- **Las acciones van en `ghost`, no en rojo.** La advertencia vive en el
  `data-confirm`, que es donde alguien la lee antes de decidir; una columna de
  botones rojos repetidos en cada fila deja de significar "cuidado".

## Dónde tocar

| Qué | Dónde |
| --- | --- |
| Estados, derivación y transiciones | `src/domains/commerce/estadoPedido.ts` |
| Mensaje de transferencia | `src/domains/commerce/datosTransferencia.ts` |
| Cuentas guardadas | `getTransferAccounts` / `saveTransferAccounts` |
| Rechazos de Wompi | `RECHAZOS_WOMPI` en `wompiWebhookHandler.ts` |
| Tabla y filtros | `renderPedidosPage` |

Para agregar un estado: sumarlo al CHECK de la migración, a `ORDER_STATUSES`,
a `derivarEstado` **en el lugar correcto de la cadena** y a `ESTADOS_VISIBLES`.
Hay un test que verifica que cada opción del filtro sea alcanzable desde
alguna combinación real — un filtro que nunca devuelve nada es peor que no
tenerlo.

## Cobertura

- `tests/unit/domains/commerce/estadoPedido.test.ts` — la precedencia de la
  derivación, incluida la que importa: que el rechazo pisa al despacho.
- `tests/unit/domains/commerce/datosTransferencia.test.ts` — que el mensaje
  lleva número de pedido y monto, omite los campos vacíos en vez de imprimir
  guiones, separa las cuentas (pegadas, un cliente puede leer el titular de
  una con el número de la otra) y pide el comprobante.
- `tests/integration/gateway/wompiWebhook.test.ts` — `DECLINED` marca
  rechazado y avisa; `PENDING` no toca nada.
- `tests/integration/gateway/admin.test.ts` — filtros con sus
  `data-filter-*` en las filas, el estado derivado y no el crudo, la
  dirección en su diálogo, y el guardado de cuentas (filas vacías
  descartadas, filas a medio llenar rechazadas).
