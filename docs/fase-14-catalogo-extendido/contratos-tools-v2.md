# Contratos de las Tools — actualizados por la Fase 14 (catálogo extendido)

Este documento reemplaza, para las tools que tocó la Fase 14, la versión de
[`docs/fase-1-arquitectura/contratos-tools.md`](../fase-1-arquitectura/contratos-tools.md)
(no se edita ese archivo mientras v2 está en diseño — ver instrucción 5 de
`PROPUESTA_V2.md`; la fusión real ocurre cuando v2 pasa a producción). Ver
[ADR-026](./adrs/ADR-026-esquema-catalogo-y-migracion-contratos-variant-id.md)
para la decisión de esquema y migración.

Cambio de fondo: `products` deja de tener `sku`/`price`/`category` propios —
esos datos viven en `product_variants` (SKU, precio y atributos reales, ej.
talla/color) y `product_categories` (árbol). Un producto genérico puede
tener una o más variantes; `consultar_inventario` y `generar_cotizacion`
operan sobre la variante concreta, no sobre el producto genérico.

Nota transversal ya vigente desde ADR-032 (Fase 13): ninguna tool recibe
`tenant_id` — agent-sale es mono-tenant, ya no hay nada que inyectar ahí.

## `consultar_inventario`

Sin cambios de input. El output pasa a ser **plano por variante** (una fila
por SKU real), no por producto genérico agrupado — el LLM es quien agrupa
variantes que comparten `product_id` al responder (ver `systemPrompt.ts`,
instrucción "preguntar variante antes de cotizar").

**Output**
```json
{
  "matches": [
    {
      "product_id": "uuid",
      "variant_id": "uuid",
      "sku": "string",
      "name": "string",
      "attributes": { "talla": "M" },
      "price": "number",
      "stock": "integer",
      "description": "string | null",
      "image_url": "string | null"
    }
  ]
}
```

## `generar_cotizacion`

`items[].product_id` pasa a `items[].variant_id` — tanto en el input que
recibe el LLM como en cada item del output.

**Input**
```json
{
  "items": [
    { "variant_id": "uuid", "quantity": "integer" }
  ]
}
```

**Output**
```json
{
  "quote_id": "uuid",
  "items": [
    { "variant_id": "uuid", "name": "string", "quantity": "integer", "unit_price": "number", "line_total": "number" }
  ],
  "subtotal": "number",
  "status": "draft"
}
```

## `crear_pedido`

Sin cambio de forma — hereda `variant_id` desde la cotización al copiar
`quote_items` → `order_items`, nunca lo recibe directo del LLM.

## `recomendar_producto`

Sin cambio de input (sigue recibiendo `product_id`, el genérico). El output
gana `variant_id` por cada recomendación, para que el LLM pueda cotizarla
directo sin una consulta extra a `consultar_inventario`.

**Output**
```json
{
  "recommendations": [
    { "product_id": "uuid", "variant_id": "uuid", "name": "string", "price": "number", "reason": "string" }
  ]
}
```

Las categorías complementarias que determinan esta recomendación viven en
`category_complements` (administrable desde `/admin/categorias`, PR 2 de
esta fase) — reemplazan el mapa `COMPLEMENTARY_CATEGORIES` que antes vivía
hardcodeado en `recomendarProducto.ts`.

## `aplicar_promocion`

Sin cambio de forma. El `free_item_sku` de una promoción de tipo "producto
gratis" (`promotions.rules`) ahora resuelve contra `product_variants.sku`
en vez de `products.sku`.
