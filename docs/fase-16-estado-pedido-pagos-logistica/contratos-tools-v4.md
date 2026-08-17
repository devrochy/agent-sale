# Contratos de las Tools — actualizados por la Fase 16 (estado de pedido, pagos y logística)

Este documento reemplaza, para las tools que tocó la Fase 16, la versión de
[`contratos-tools-v3.md`](../fase-15-datos-cliente-flujo-pedidos/contratos-tools-v3.md).
Ver [ADR-034](./adrs/ADR-034-numero-publico-cierre-automatico-logistica.md)
para las decisiones de esquema y de privacidad.

## `crear_pedido`

Gana `public_order_number` en el output — lo deriva Postgres solo a partir
de `orders.order_seq` (ver ADR-034), la tool no lo genera ni lo elige. El
resto del contrato (input, y demás campos del output) no cambia respecto a
`contratos-tools-v3.md`.

**Output** (solo el campo nuevo)
```json
{
  "order_id": "uuid | null",
  "status": "confirmed | duplicate | monto_alto | wompi_no_configurado | wompi_monto_minimo | faltan_datos_cliente",
  "public_order_number": "string, formato \"FM-0001\" (solo si status es confirmed o duplicate)",
  "total": "number",
  "payment_link_url": "string (solo si payment_method es pago_en_linea y status confirmed)"
}
```

## `consultar_estado_pedido` (nueva)

Devuelve el estado real de un pedido a partir de su `public_order_number`.
Siempre acotada al cliente que pregunta (ver ADR-034: un número que existe
pero es de otro cliente devuelve el mismo `found: false` que uno
inexistente — nunca revela que el pedido existe).

**Input**
```json
{
  "public_order_number": "string, ej. \"FM-0001\" (acepta variantes: minúsculas, sin guion, sin ceros de relleno)"
}
```

**Output**
```json
{
  "found": "boolean",
  "public_order_number": "string (solo si found es true)",
  "status": "string, valor real de orders.status (abierto | expirado | ...) (solo si found es true)",
  "payment_status": "string (solo si found es true)",
  "delivery_method": "domicilio | recoger_en_tienda (solo si found es true)",
  "tracking_number": "string | null (solo si found es true)",
  "carrier": "string | null (solo si found es true)",
  "total": "number (solo si found es true)",
  "created_at": "string ISO 8601 (solo si found es true)",
  "items": [
    { "name": "string", "quantity": "integer" }
  ]
}
```

- Si el `public_order_number` no matchea el patrón esperado (`FM-` seguido de
  1 a 4 dígitos, con o sin guion/espacio, sin importar mayúsculas), devuelve
  `found: false` sin consultar la base.
- El orquestador nunca debe inventar ni asumir el estado de un pedido —
  siempre debe llamar a esta tool cuando el cliente pregunte, y si devuelve
  `found: false`, pedirle que confirme el número o decirle con naturalidad
  que no lo encontró, sin confirmar ni negar que le pertenece a otra
  persona.
