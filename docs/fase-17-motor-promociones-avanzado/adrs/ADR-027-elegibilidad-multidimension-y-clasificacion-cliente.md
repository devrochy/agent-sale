# ADR-027: Elegibilidad de promoción multi-dimensión y clasificación de cliente sin romper "no combinar"

## Estado
Propuesta (pendiente de aceptación antes de iniciar implementación de la Fase 17).

## Contexto

[`motor-promociones.md`](../../fase-6-dominio-comercial/motor-promociones.md) (Fase 6) define un motor que evalúa promociones de `"temporada"` y `"volumen"`, elige siempre la de mayor beneficio para el cliente, y **no combina/apila promociones** — decisión confirmada explícitamente con ForMotos y documentada como "la regla definitiva, no un valor por defecto provisional". `PROPUESTA_V2.md` §3.7 pide agregar tres dimensiones de elegibilidad nuevas (aliado, categoría/subcategoría, producto puntual) y un tipo de promoción por campaña con restricción de una aplicación por cliente, más una clasificación de cliente (nuevo/recurrente/fiel) de la que depende esa elegibilidad.

El riesgo central de esta ADR es de diseño, no de dato: agregar dimensiones de elegibilidad *parece* un cambio menor, pero si se implementa mal puede terminar apilando descuentos (ej. "10% de aliado + 15% de campaña de bienvenida") — exactamente lo que la regla de Fase 6 prohíbe.

## Opciones consideradas

1. **Tratar cada dimensión nueva como un tipo de promoción independiente que se combina con las existentes** (aditivo) — descartada explícitamente: revierte la regla ya confirmada con el negocio sin que nadie haya pedido revisarla; `PROPUESTA_V2.md` no pide combinar, pide más *formas* de ser elegible para el mismo mecanismo de "la de mayor beneficio".
2. **Las dimensiones nuevas son criterios de elegibilidad sobre el mismo pool de candidatas, la regla de selección no cambia** — elegida.

## Decisión

### Elegibilidad como filtro, no como combinación

`promotions` gana columnas de elegibilidad, todas nullable (sin restricción = aplica a todo el catálogo, comportamiento actual preservado sin cambios para las promociones ya existentes de ForMotos):

```sql
ALTER TABLE promotions
  ADD COLUMN ally_id uuid REFERENCES allies(id),
  ADD COLUMN category_id uuid REFERENCES product_categories(id),
  ADD COLUMN include_child_categories boolean DEFAULT true,
  ADD COLUMN product_id uuid REFERENCES products(id),
  ADD COLUMN variant_id uuid REFERENCES product_variants(id);
```

El motor de `aplicar_promocion` (paso 1 de `motor-promociones.md`, "filtrar promociones activas") gana un sub-paso: de las promociones activas, descartar las que tengan una columna de elegibilidad que no coincida con los ítems de la cotización actual. El resto del algoritmo (evaluar volumen, evaluar temporada, **elegir la de mayor beneficio, sin combinar**) no cambia una sola línea — las promociones de campaña/aliado/categoría entran al mismo paso 4 de comparación que ya existe, compitiendo por "mayor descuento", nunca sumándose.

### Campaña como `kind` nuevo, con restricción de uso

```json
{ "kind": "campaña", "label": "bienvenida", "discount_pct": 15, "once_per_customer": true }
```

Tabla nueva `promotion_redemptions` (`promotion_id`, `customer_id`, `order_id`, `redeemed_at`) — se inserta cuando `aplicar_promocion` efectivamente aplica una promoción con `once_per_customer: true`. El paso 1 del motor (filtrar activas) descarta cualquier promoción de campaña que ya tenga una fila en `promotion_redemptions` para ese `customer_id`. Se prefiere una tabla dedicada sobre reutilizar `audit_log` porque la pregunta "¿este cliente ya usó esta campaña?" necesita un índice directo (`customer_id`, `promotion_id`), no un escaneo del log de auditoría general.

### Clasificación de cliente: derivada, no editable a mano

`customers.segment` **no** es una columna editable — se calcula on-demand (o se cachea con recálculo periódico, a decidir en implementación según costo de la query) a partir de `COUNT(orders) WHERE customer_id = ... AND status = 'confirmed'`:

- `nuevo`: 0 pedidos confirmados.
- `recurrente`: 2+ pedidos confirmados (umbral configurable por tenant, mismo patrón `escalation_config`/jsonb con default).
- `fiel`: umbral superior, a validar con datos reales del piloto antes de fijarlo en producción — mismo criterio que el umbral de "monto alto" de Fase 7, que Fase 9 dejó pendiente de validar con tráfico real en vez de un número de diseño.

Este segmento se usa como una dimensión de elegibilidad más (`promotions.eligible_segments text[]`, ej. `{'nuevo'}` para una promoción de bienvenida), evaluado en el mismo paso de filtrado que las demás.

### Comunicación proactiva sin violar el guardrail de precios

El orquestador (`systemPrompt.ts`, bloque compartido) gana una instrucción: al detectar interés explícito del cliente en una categoría/producto, **llamar a `aplicar_promocion` de forma anticipada** (antes del cierre del pedido) sobre una cotización preliminar de ese producto, y solo entonces mencionar el resultado real devuelto por la tool. El LLM nunca menciona "hay descuento" antes de que la tool lo haya confirmado — el cambio es *cuándo* se llama la tool (más temprano en la conversación), no que el LLM decida el descuento por su cuenta.

## Consecuencias

- La regla "no se combinan promociones" de Fase 6 queda intacta y documentada como tal en esta ADR — cualquier futura revisión de esa regla requiere su propia ADR, no se reabre aquí en silencio.
- `promotion_redemptions` es la única tabla verdaderamente nueva de esta fase; el resto son columnas de elegibilidad sobre `promotions` ya existente.
- El umbral de "fiel" queda explícitamente pendiente de validación con datos reales — no se fija un número en esta ADR, evitando repetir el mismo tipo de pendiente que ya arrastra el umbral de "monto alto" desde la Fase 7.
