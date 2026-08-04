# Contratos de las Tools — actualizados por la Fase 17 (motor de promociones avanzado)

Este documento reemplaza, solo para `aplicar_promocion`, la versión de
[`contratos-tools-v4.md`](../fase-16-estado-pedido-pagos-logistica/contratos-tools-v4.md).
Ver [ADR-027](./adrs/ADR-027-elegibilidad-multidimension-y-clasificacion-cliente.md)
para las decisiones de elegibilidad y clasificación de cliente. El resto de
las tools no cambia respecto a `contratos-tools-v4.md`.

## `aplicar_promocion`

El input no cambia. La tool sigue evaluando toda la elegibilidad y el
cálculo del descuento — el LLM nunca decide ni calcula un porcentaje, solo
reporta lo que la tool devuelve. Lo nuevo es que ahora la evaluación puede
filtrar por aliado, categoría/subcategoría, producto o variante puntual, y
segmento de cliente (nuevo/recurrente/fiel), y que existe un tipo de
promoción `"campaña"` (ej. un descuento de bienvenida limitado a una vez
por cliente) que compite por "mayor beneficio" en el mismo paso que
`"temporada"` y `"volumen"` — nunca se combinan entre sí.

**Input** (sin cambios respecto a `contratos-tools-v4.md`)
```json
{
  "quote_id": "uuid de la cotización (de generar_cotizacion)",
  "promo_code": "string (opcional, informativo — no hay sistema de códigos, ver aplicarPromocion.ts)"
}
```

**Output** (gana `"campaña"` como valor posible de `promotion_applied.kind`)
```json
{
  "quote_id": "uuid",
  "promotion_applied": {
    "id": "uuid",
    "kind": "temporada | volumen | campaña",
    "description": "string, ej. \"Bienvenida (15% de descuento)\""
  },
  "subtotal": "number",
  "discount": "number",
  "total": "number"
}
```

- `promotion_applied` es `null` cuando ninguna promoción activa es elegible
  para esa cotización — en ese caso `discount` es `0` y `total === subtotal`.
- La elegibilidad de una promoción es "todo o nada" sobre la cotización
  completa: si tiene `ally_id`/`category_id`/`product_id`/`variant_id`
  seteados, **todas** las líneas de la cotización deben cumplir esa
  dimensión, o la promoción entera queda descartada — no hay descuento
  parcial por línea.
- Una promoción `"campaña"` con `once_per_customer: true` deja de ser
  elegible para un cliente apenas ese cliente confirma un pedido (vía
  `crear_pedido`) que la aplicó — la redención se registra al confirmar el
  pedido, no al cotizar, así que cotizar con la campaña aplicada y no
  comprar no la consume.
- Llamar esta tool apenas se genera una cotización con `generar_cotizacion`
  (aunque sea preliminar y el cliente no haya preguntado por descuentos)
  para poder mencionar proactivamente un beneficio si aplica, y también
  cuando el cliente pregunta explícitamente por descuentos sobre una
  cotización ya generada — nunca inventar ni calcular un porcentaje, ni
  mencionar una promoción que la tool no haya confirmado.
