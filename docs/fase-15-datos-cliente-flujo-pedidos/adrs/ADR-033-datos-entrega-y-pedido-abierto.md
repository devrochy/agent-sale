# ADR-033: Captura progresiva de datos de entrega y pedido abierto

## Estado
Aceptada.

## Contexto

`MASTER_PLAN_V2.md` (Fase 15) y el README original de esta fase dejaban dos puntos explícitamente abiertos ("a decidir en implementación") y afirmaban que la fase "no amerita ADR propia". En la práctica, la implementación tomó dos decisiones de arquitectura reales que sí atraviesan el sistema — de ahí que esta ADR corrija esa afirmación:

1. Qué tan grande es el cambio de "pedido abierto": ¿solo aplica a `pago_en_linea` (que ya tenía un estado intermedio de pago pendiente) o a todo pedido, sin importar el método de pago?
2. Si "agregar un producto a un pedido abierto" es una tool nueva con su propio mecanismo de idempotencia, o una reapertura del `quote_id` original.

Se resolvieron antes de implementar, verificando contra el código real: `orders.status` solo se escribía en un lugar (`crearPedido.ts`, literal `'confirmed'`) y solo se leía para mostrarlo en el panel admin — ningún job (`dailyReport.ts`, `cazadorDeVentas.ts`) ni el webhook de Wompi filtran por `status`, así que cambiar el valor no rompe nada existente. No hay CHECK constraint sobre la columna (`migrations/0007_quotes_orders.cjs`).

## Decisión

### 1. Captura progresiva de datos de cliente — extensión de `crear_pedido`, no tool nueva

`crear_pedido` gana un parámetro opcional `customer_data` (address/id_document/full_name obligatorios, municipality/city opcionales, save_permanently). La tool **siempre exige** `customer_data` completo para llegar a `status: "confirmed"` — nunca reutiliza en silencio los datos ya guardados en `customers`. Si no viene, devuelve `status: "faltan_datos_cliente"` con `existing_data` (lo que haya guardado, o `null` si el cliente es nuevo) y `missing_fields`, sin crear nada — mismo patrón "la tool se niega, el orquestador nunca decide por su cuenta" que ya usa `monto_alto`.

Esto obliga a que la confirmación conversacional del cliente ("¿tu dirección sigue siendo la misma?") sea siempre explícita, igual que `crear_pedido` ya exige una confirmación explícita de compra antes de llamarse.

`customers.full_name` es una columna nueva y separada de `customers.name` (que sigue siendo el `ProfileName` de WhatsApp, auto-capturado, sin tocar): `full_name` es el nombre formal que el cliente confirma para la entrega.

`orders` gana columnas de snapshot (`delivery_address`, `delivery_id_document`, `delivery_full_name`, `delivery_municipality`, `delivery_city`) — el pedido guarda la dirección/cédula/nombre *usados en ese pedido puntual*, independiente de que después el cliente actualice su perfil en `customers`. Todas nullable (pedidos/clientes anteriores a la migración no las tienen).

**Cédula en texto plano**: mismo criterio que `customers.phone_number`/`name` hoy — no hay ADR ni requisito legal de cifrado de PII de cliente en el proyecto. Queda documentado como riesgo pendiente de revisión legal, no se resuelve en esta ADR.

### 2. `orders.status = 'abierto'` para todo pedido nuevo, sin importar el método de pago

Se cambia el literal `'confirmed'` por `'abierto'` en el INSERT de `crearPedido.ts` — sin importar `payment_method`. Es un cambio de fondo, no acotado a pago en línea: un pedido en efectivo contra entrega o por transferencia también puede recibir productos adicionales antes de despacharse.

**Alcance explícito de "abierto" en esta fase**: `crear_pedido` crea el pedido en `'abierto'` y ahí se queda — esta fase no construye ningún mecanismo de cierre (eso es de la Fase 16, "Estado de Pedido, Pagos y Logística", que comparte dominio con esta fase para evitar dos rondas de migración sobre `orders`). La Definición de Terminado de esta fase solo exige que un pedido abierto pueda recibir un producto adicional sin generar un segundo `order_id`.

### 3. `agregar_item_pedido` — tool nueva, con idempotencia propia

Se descarta reabrir el `quote_id` original: una cotización ya convertida en pedido sigue siendo 0..1 con su pedido (invariante ya establecida en Fase 6), y reutilizar ese `quote_id` para un segundo lote de items rompería esa relación o forzaría a tratar `quote_items` como mutable después de confirmado.

En su lugar, tool nueva `agregar_item_pedido(order_id, items[])`, mismo patrón de revalidación de stock/precio real que `generar_cotizacion`/`crear_pedido`. Idempotencia propia con tabla `order_item_batches` (`idempotency_key` UNIQUE, `sha256(order_id + ':' + messageSid)`) — a nivel de "lote de items agregados en un intento", no a nivel de pedido completo, porque un pedido abierto puede recibir N lotes en momentos distintos. El helper `buildIdempotencyKey` se extrae de `crearPedido.ts` a `idempotency.ts` para no duplicar el mecanismo.

Si el pedido es `pago_en_linea` y ya tiene un link de pago pendiente, se regenera con el total actualizado (mismo mecanismo que ya usa `crear_pedido` vía `wompiClient.ts`/`wompi_payment_links`) — evita que el cliente pague un link con el monto viejo después de agregar productos.

## Alternativas consideradas

- **Reabrir pago en línea únicamente ("abierto" = solo mientras el link de Wompi está pendiente).** Descartada: dejaría a los pedidos en efectivo/transferencia sin la misma posibilidad de sumar productos antes de despacharse, una asimetría sin justificación de negocio — el código real tampoco tenía ninguna dependencia que forzara esa restricción.
- **Reapertura de `quote_id` en vez de tool nueva.** Descartada por romper la invariante 0..1 `quotes → orders` ya establecida, y porque el mecanismo de idempotencia de `crear_pedido` está diseñado para "convertir una cotización una sola vez", no para lotes repetidos sobre el mismo pedido.

## Consecuencias

- **Esquema**: `migrations/0046_customers_datos_entrega.cjs` (columnas `customers.*`/`orders.delivery_*`), `migrations/0047_order_item_batches.cjs` (tabla nueva, sin RLS — ver ADR-032, ya no hay multi-tenancy que proteger).
- **Código**: `crearPedido.ts` (`customer_data`, `faltan_datos_cliente`, `'abierto'` en vez de `'confirmed'`), `idempotency.ts` nuevo, `agregarItemPedido.ts` nuevo, `toolDefinitions.ts`/`toolExecutor.ts`/`loop.ts`/`systemPrompt.ts` extendidos.
- **Panel admin**: `/admin/pedidos` muestra `delivery_address`/`delivery_id_document` del snapshot del pedido.
- **Riesgo pendiente**: cédula en texto plano — revisión legal de protección de datos personales queda fuera de esta ADR.
- Corrige la afirmación del README original de esta fase ("no amerita ADR propia").
