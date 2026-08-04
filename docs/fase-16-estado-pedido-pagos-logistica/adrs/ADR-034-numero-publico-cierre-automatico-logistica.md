# ADR-034: Número público de pedido, cierre automático y logística

## Estado
Aceptada.

## Contexto

El README original de esta fase afirmaba "Sin ADR propia — es una extensión
directa de patrones ya aceptados (ADR-018, ADR-024)". En la práctica, la
implementación tomó tres decisiones de arquitectura reales que sí atraviesan
el sistema — de ahí que esta ADR corrija esa afirmación, mismo criterio que
[ADR-033](../../fase-15-datos-cliente-flujo-pedidos/adrs/ADR-033-datos-entrega-y-pedido-abierto.md)
en la fase anterior:

1. Cómo generar un número de pedido corto y no adivinable-en-el-sentido-de-UUID
   para que el cliente pregunte por su estado, sin que la aplicación tenga que
   generarlo ni competir por él.
2. Qué hacer con el stock y con el cliente cuando un pedido `pago_en_linea`
   nunca se paga — la Definición de Terminado escrita solo pedía el cambio de
   estado, sin resolver ni stock ni notificación.
3. Cómo extender la regla de `systemPrompt.ts` que prohíbe mencionar
   identificadores internos (`order_id`/`quote_id`) sin abrir una grieta que
   permita filtrar esos identificadores por otra vía.

## Decisión

### 1. `public_order_number` generado por Postgres, no por la aplicación

`orders` gana `order_seq` (`integer`, secuencia propia `orders_order_seq_seq`,
backfill en orden de `created_at` para los pedidos existentes, `DEFAULT
nextval(...)` para los nuevos) y `public_order_number` (`text GENERATED
ALWAYS AS ('FM-' || lpad(order_seq::text, 4, '0')) STORED`, `UNIQUE`).

Se descarta generarlo en `crearPedido.ts` (ej. `SELECT count(*) + 1` o un
`nextval` manual dentro de la transacción): con una columna `GENERATED ...
STORED` derivada de una secuencia dedicada, Postgres garantiza unicidad y
orden sin que la aplicación tenga que preocuparse por condiciones de carrera
entre dos `crearPedido.ts` concurrentes. `order_seq` es una secuencia
**separada** del `id` (UUID) — el UUID no es corto ni secuencial, no sirve
para que un cliente lo dicte por WhatsApp.

Al `agent_sale_app` (rol de aplicación, `migrations/0011_app_role.cjs`) no le
alcanza con el `ALTER DEFAULT PRIVILEGES` existente para poder usar la
secuencia nueva — esa cláusula solo cubre `TABLES`, no `SEQUENCES` — por lo
que la migración agrega `GRANT USAGE, SELECT ON SEQUENCE
orders_order_seq_seq TO agent_sale_app` explícito.

### 2. El cierre automático libera el stock reservado y notifica al cliente

La Definición de Terminado original solo pedía "pasa a `expirado`
automáticamente". Se agregaron dos comportamientos no pedidos explícitamente,
validados con el usuario antes de implementar:

- **Libera el stock.** `crearPedido.ts` descuenta stock al crear el pedido
  sin importar si ya se pagó (ver comentario en ese archivo) — si el pedido
  `pago_en_linea` nunca se pagó, esas unidades nunca se vendieron de verdad y
  quedarían bloqueadas indefinidamente si el job no las libera.
- **Notifica por WhatsApp.** Sin esto el cliente nunca se entera de que su
  pedido se cerró — mismo criterio de que un cambio de estado sin
  notificación es trabajo a medias, ya aplicado en `cazadorDeVentas.ts`.

**Estado final `'expirado'`, no `'cancelado'`** — `'cancelado'` queda
reservado para una futura acción manual (ej. el admin cancelando un pedido a
mano) que esta fase no construye; usar el mismo literal para ambos casos
mezclaría "el sistema lo cerró por inacción" con "alguien lo canceló a
propósito".

**Guard de idempotencia explícito** contra el riesgo de doble notificación
en el borde de los 5 días (riesgo ya señalado en el README): el `UPDATE
orders SET status = 'expirado' WHERE id = $1 AND payment_status =
'pendiente' RETURNING id` solo libera stock y notifica si de verdad afectó
una fila — mismo criterio que ya usa el webhook de Wompi (`WHERE
payment_status = 'pendiente'`) para el caso donde el pago se aprueba justo
antes de que corra el job.

### 3. `public_order_number` es la excepción explícita a "nunca reveles identificadores internos"

`systemPrompt.ts` ya prohibía mencionar `order_id`/`quote_id` al cliente
(son UUIDs internos, sin valor para él y con riesgo de filtrar detalles de
implementación). `public_order_number` es distinto por diseño: es
justamente el dato que el cliente necesita para poder preguntar por su
pedido después, así que se agrega como excepción explícita e instrucción de
usarlo al confirmar un pedido nuevo — no una relajación general de la regla.

**Privacidad de `consultar_estado_pedido`**: el número es secuencial y por
lo tanto adivinable (`FM-0001`, `FM-0002`...). La tool siempre filtra
`WHERE public_order_number = $1 AND customer_id = $2` (el `customerId` lo
inyecta el orquestador, nunca es un parámetro visible para el LLM) — un
número que existe pero pertenece a otro cliente devuelve el mismo `found:
false` que uno inexistente, sin filtrar que el pedido existe.

### 4. `registrarGuia.ts` vive en `domains/commerce`, no en el panel admin

A diferencia de la mayoría de las acciones CRUD del panel (`guardarProducto`,
`crearAliado`, etc., que viven directamente en `adminPanel.ts` delegando a
`shared/db/*Directory.ts`), `registrarGuia.ts` se ubica junto a
`crearPedido.ts`/`agregarItemPedido.ts` en `src/domains/commerce/`: no es
gestión de catálogo, es lógica del ciclo de vida del pedido con un efecto de
negocio real (notificar al cliente por WhatsApp), del mismo dominio que las
otras funciones de ese directorio.

`shipped_at IS NULL` funciona como guard de "primera vez" (solo notifica una
vez), pero `shipped_at = COALESCE(shipped_at, now())` permite corregir
`tracking_number`/`carrier` después sin volver a notificar — mismo criterio
de guard idempotente que el punto 2.

## Alternativas consideradas

- **Generar `public_order_number` en la aplicación** (ej. contar pedidos
  existentes o usar un UUID corto). Descartada: abre una condición de
  carrera entre inserciones concurrentes que una columna `GENERATED ...
  STORED` sobre una secuencia dedicada evita por construcción, sin lógica
  adicional en `crearPedido.ts`.
- **Estado final `'cancelado'` en vez de `'expirado'`.** Descartada por
  mezclar dos causas distintas (inacción del sistema vs. cancelación manual)
  bajo el mismo literal, cerrando la puerta a una futura acción de
  cancelación manual sin ambigüedad.
- **No liberar stock ni notificar al cerrar automáticamente.** Descartada:
  dejaría stock reservado indefinidamente por pedidos que nunca se pagaron y
  al cliente sin saber que su pedido se cerró — alcance mínimo que no
  resuelve el problema real que motiva el job.

## Consecuencias

- **Esquema**: `migrations/0048_orders_public_number_logistica.cjs`
  (`order_seq`, `public_order_number`, `tracking_number`, `carrier`,
  `shipped_at`, más el `GRANT` de la secuencia nueva al rol de aplicación).
- **Código**: `crearPedido.ts` expone `public_order_number` en su output;
  `consultarEstadoPedido.ts` y `registrarGuia.ts` nuevos;
  `closeExpiredOrders.ts` nuevo (registrado en `scheduler.ts`, corre a las
  9am hora Bogotá); `toolDefinitions.ts`/`toolExecutor.ts`/`systemPrompt.ts`
  extendidos.
- **Panel admin**: `/admin/pedidos` gana columnas de número público, estado
  de pago (solo para `pago_en_linea`) y guía de envío (con dialog para
  registrarla cuando el pedido es a domicilio).
- Corrige la afirmación del README original de esta fase ("Sin ADR propia").
