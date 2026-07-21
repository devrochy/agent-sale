# Motor de Reglas de Promociones

Implementación concreta de la tool `aplicar_promocion` (contrato en [contratos-tools.md](../fase-1-arquitectura/contratos-tools.md), estructura de `promotions.rules` en [modelo-datos.md](../fase-1-arquitectura/modelo-datos.md), ambos de la Fase 1) sobre las promociones reales de ForMotos levantadas en la [Fase 0](../fase-0-descubrimiento.md): por temporada (fin de año, día de celebridad) y por volumen (tramos de unidades).

## Principio: la tool evalúa, nunca el LLM

Igual que el resto del sistema, Claude puede *sugerir* que aplica una promoción ("mencionaste que hay descuento de fin de año, ¿lo aplico?"), pero el cálculo del descuento lo hace exclusivamente la tool, leyendo `promotions.rules` de Postgres — nunca se confía en que el modelo calcule un porcentaje correctamente.

## Orden de evaluación

Cuando se llama `aplicar_promocion` sobre una cotización (`quote_id`), el motor evalúa en este orden:

1. **Filtrar promociones activas** — `promotions.active = true` y la fecha actual dentro de `[valid_from, valid_to]` (para las de temporada) o sin restricción de fecha (para las de volumen, que dependen de la cantidad, no de la fecha).
2. **Evaluar promociones de volumen** — sumar la cantidad total de unidades en la cotización y encontrar el tramo (`tiers`) que corresponde (ej. 10-20 unidades → 5% descuento, ver ejemplo en [modelo-datos.md](../fase-1-arquitectura/modelo-datos.md)).
3. **Evaluar promociones de temporada** — si hay una activa (ej. "fin de año"), calcular su descuento sobre el mismo subtotal.
4. **Elegir la de mayor beneficio para el cliente** — si tanto una promoción de volumen como una de temporada aplicarían, el motor compara el descuento resultante de cada una y aplica la que dé el mayor descuento al cliente. **No se combinan/apilan promociones** en este diseño — evita el caso de negocio ambiguo de "¿el 10% de volumen se aplica antes o después del 15% de temporada?", que ForMotos no definió en la Fase 0.

Esta regla de "no combinar, elegir la mejor" es una decisión de diseño para evitar ambigüedad — **debe confirmarse con ForMotos** antes de implementar, ya que es posible que el negocio sí quiera combinarlas. Se documenta como el comportamiento por defecto más seguro (nunca cobrar de más ni generar un descuento no autorizado) mientras no haya una regla de combinación explícita.

## Producto/servicio gratis (beneficio no monetario)

La Fase 0 registró que el beneficio de una promoción por volumen puede ser "producto/servicio gratis", no solo un % de descuento. Esto se modela como una variante de `promotions.rules`:

```json
{ "kind": "volumen", "tiers": [{ "min": 20, "max": 40, "free_item_sku": "GUANTES-BASICO" }] }
```

Cuando la tool detecta un tramo con `free_item_sku` en vez de `discount_pct`, agrega ese producto a la cotización con `unit_price: 0` y una nota interna (`quote_items` no necesita un campo nuevo — el precio en cero ya distingue la línea) para que quede claro en la cotización mostrada al cliente que es un obsequio, no un error de precio.

## Qué pasa si no hay ninguna promoción aplicable

La tool devuelve la cotización sin cambios (`promotion_applied: null`, `discount: 0`), y el agente lo comunica de forma directa al cliente si preguntó — no se inventa una promoción ni se aplica un descuento "de buena voluntad" fuera de lo que existe en `promotions`.

## Qué no cubre este documento
- Implementación real del cálculo (código) — fuera del alcance de este plan de arquitectura.
- Confirmación de la regla "no combinar promociones" con el dueño de ForMotos — pendiente, marcado arriba.
