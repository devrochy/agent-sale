# Contratos de las Tools — actualizados por la Fase 15 (datos de cliente y pedido abierto)

Este documento reemplaza, para las tools que tocó la Fase 15, la versión de
[`contratos-tools-v2.md`](../fase-14-catalogo-extendido/contratos-tools-v2.md)
(no se edita ese archivo mientras v2 está en diseño — ver instrucción 5 de
`PROPUESTA_V2.md`; la fusión real ocurre cuando v2 pasa a producción). Ver
[ADR-033](./adrs/ADR-033-datos-entrega-y-pedido-abierto.md) para las
decisiones de esquema y de idempotencia.

## `crear_pedido`

Gana un parámetro opcional `customer_data` — obligatorio en la práctica para
llegar a `status: "confirmed"` (ver ADR-033: la tool nunca reutiliza en
silencio datos ya guardados). `orders.status` nace en `'abierto'` (antes
`'confirmed'`) sin importar `payment_method`.

**Input**
```json
{
  "quote_id": "uuid",
  "payment_method": "transferencia | efectivo_contraentrega | tarjeta | pago_en_linea",
  "delivery_method": "domicilio | recoger_en_tienda",
  "customer_data": {
    "address": "string",
    "id_document": "string",
    "full_name": "string",
    "municipality": "string (opcional)",
    "city": "string (opcional)",
    "save_permanently": "boolean"
  }
}
```

**Output**
```json
{
  "order_id": "uuid | null",
  "status": "confirmed | duplicate | monto_alto | wompi_no_configurado | wompi_monto_minimo | faltan_datos_cliente",
  "total": "number",
  "payment_link_url": "string (solo si payment_method es pago_en_linea y status confirmed)",
  "missing_fields": ["address | id_document | full_name (solo si status es faltan_datos_cliente)"],
  "existing_data": {
    "address": "string | null",
    "id_document": "string | null",
    "full_name": "string | null",
    "municipality": "string | null",
    "city": "string | null"
  }
}
```

Si `customer_data` no viene, o falta alguno de los 3 campos obligatorios, la
tool no crea el pedido — devuelve `status: "faltan_datos_cliente"` con
`existing_data` (lo que haya guardado el cliente de un pedido anterior, o
`null` si es nuevo) y `missing_fields`. El orquestador debe mostrarle esos
datos al cliente y pedirle confirmación explícita antes de reintentar.

## `agregar_item_pedido` (nueva)

Suma productos a un pedido `abierto` sin generar un segundo `order_id`. Mismo
patrón de revalidación de stock/precio real que `generar_cotizacion`. Ver
ADR-033 para el mecanismo de idempotencia (`order_item_batches`,
independiente del `idempotency_key` de `orders`).

**Input**
```json
{
  "order_id": "uuid",
  "items": [
    { "variant_id": "uuid", "quantity": "integer" }
  ]
}
```

**Output**
```json
{
  "order_id": "uuid",
  "status": "actualizado | duplicate | pedido_no_abierto | monto_alto",
  "items_agregados": [
    { "variant_id": "uuid", "name": "string", "quantity": "integer", "unit_price": "number", "line_total": "number" }
  ],
  "total": "number",
  "payment_link_url": "string (solo si el pedido es pago_en_linea y ya tenía un link pendiente, con el total actualizado)"
}
```

- `pedido_no_abierto`: el `order_id` no existe o su `status` ya no es
  `'abierto'` — no inserta nada.
- `monto_alto`: el total del pedido (existente + items nuevos) supera
  `montoAltoThreshold` — no inserta nada, mismo umbral que ya usa
  `crear_pedido`.
- `duplicate`: mismo `messageSid` ya procesado para este `order_id` (lote ya
  registrado en `order_item_batches`) — devuelve el total actual sin volver
  a descontar stock.
