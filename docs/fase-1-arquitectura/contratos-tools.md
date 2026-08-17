# Contratos de las Tools (Tool Calling con Claude)

Principio rector: **el LLM propone, la tool decide**. Ninguna tool confía en que el modelo haya calculado bien un precio, un descuento o una disponibilidad — cada tool vuelve a validar contra Postgres antes de responder.

Todas las tools reciben implícitamente `tenant_id` y `conversation_id` desde el contexto del orquestador (no los expone el LLM), para que no puedan usarse fuera del tenant/conversación activos.

## `consultar_inventario`

Responde disponibilidad y precio de productos del catálogo.

**Input**
```json
{
  "query": "string — término de búsqueda libre, ej. 'casco talla M'",
  "sku": "string | null — si el cliente ya especificó un SKU exacto"
}
```

**Output**
```json
{
  "matches": [
    {
      "product_id": "uuid",
      "sku": "string",
      "name": "string",
      "price": "number",
      "stock": "integer",
      "variants": ["string"]
    }
  ]
}
```

## `generar_cotizacion`

Crea una cotización a partir de una lista de productos y cantidades. No aplica promociones (eso lo hace `aplicar_promocion` a continuación, de forma explícita).

**Input**
```json
{
  "items": [
    { "product_id": "uuid", "quantity": "integer" }
  ]
}
```

**Output**
```json
{
  "quote_id": "uuid",
  "items": [
    { "product_id": "uuid", "name": "string", "quantity": "integer", "unit_price": "number", "line_total": "number" }
  ],
  "subtotal": "number",
  "status": "draft"
}
```

## `aplicar_promocion`

Evalúa las promociones activas del tenant contra una cotización existente y aplica la que corresponda (temporada o volumen). No permite que el LLM invente un descuento: solo ejecuta las reglas almacenadas en `promotions.rules`.

**Input**
```json
{
  "quote_id": "uuid",
  "promo_code": "string | null — opcional, si el cliente menciona un código"
}
```

**Output**
```json
{
  "quote_id": "uuid",
  "promotion_applied": { "id": "uuid", "kind": "temporada | volumen", "description": "string" } ,
  "discount": "number",
  "total": "number"
}
```

## `crear_pedido`

Convierte una cotización aceptada en un pedido. Requiere `idempotency_key` para que un reintento del webhook de WhatsApp no genere un pedido duplicado.

**Input**
```json
{
  "quote_id": "uuid",
  "payment_method": "transferencia | efectivo_contraentrega | tarjeta",
  "delivery_method": "domicilio | recoger_en_tienda",
  "idempotency_key": "string"
}
```

**Output**
```json
{
  "order_id": "uuid",
  "status": "confirmed | duplicate",
  "total": "number"
}
```

## `recomendar_producto`

Sugiere productos relacionados usando similitud de embeddings (`pgvector`) sobre el catálogo, más reglas simples (ej. mismo `category`). No es un modelo de ML propio — es búsqueda por similitud + reglas.

**Input**
```json
{
  "context": "string — texto de la conversación reciente o producto de referencia",
  "product_id": "uuid | null — si la recomendación parte de un producto ya visto"
}
```

**Output**
```json
{
  "recommendations": [
    { "product_id": "uuid", "name": "string", "price": "number", "reason": "string" }
  ]
}
```

## `escalar_a_humano`

Registra la conversación en `handoff_queue`. La decisión de *cuándo* llamarla no depende del criterio libre del LLM — el orquestador la invoca cuando la máquina de estados de escalamiento (reglas explícitas: intentos fallidos, palabras clave, monto alto, solicitud directa) lo determina. El LLM puede sugerir que se necesita, pero la regla final es del sistema, no del modelo.

**Input**
```json
{
  "reason": "compatibilidad_tecnica | monto_alto | solicitud_cliente | intentos_fallidos | queja",
  "summary": "string — resumen breve de la conversación para el asesor"
}
```

**Output**
```json
{
  "handoff_id": "uuid",
  "status": "queued",
  "assigned_to": "uuid | null"
}
```

## Notas transversales

- Todas las tools registran su ejecución completa (input + output) en `audit_log`.
- Ninguna tool acepta `tenant_id` como parámetro del LLM — se inyecta desde el contexto de sesión, para eliminar la posibilidad de que un prompt manipulado cruce datos entre tenants.
- Los schemas aquí descritos son el contrato funcional para la Fase 1; el formato exacto de definición de tools para la API de Claude (JSON Schema estricto, `tool_choice`, etc.) se resuelve al implementar el orquestador (Fase 4).
