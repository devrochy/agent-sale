# Fase 17 — Motor de Promociones Avanzado y Clasificación de Clientes

Estado: **en diseño** (v2)

Referencia: [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md#fase-17--motor-de-promociones-avanzado-y-clasificación-de-clientes) · [PROPUESTA_V2.md §3.7](../../PROPUESTA_V2.md) · [Fase 6 — Motor de Promociones](../fase-6-dominio-comercial/motor-promociones.md) · [Fase 14](../fase-14-catalogo-extendido/README.md) · [Fase 16](../fase-16-estado-pedido-pagos-logistica/README.md)

Extiende `aplicar_promocion` para evaluar elegibilidad por aliado, categoría/subcategoría, producto puntual y campaña (con restricción de una aplicación por cliente), incorporando una clasificación de cliente (nuevo/recurrente/fiel), **sin romper la regla ya confirmada con ForMotos de que las promociones no se combinan**.

## Relación con v1

- **Extiende** [`motor-promociones.md`](../fase-6-dominio-comercial/motor-promociones.md) (Fase 6) — la regla de cierre *"Confirmado con ForMotos: las promociones no se combinan... Esta es la regla definitiva, no un valor por defecto provisional"* **se mantiene íntegra**. Las nuevas dimensiones (aliado/categoría/campaña) se tratan como filtros de elegibilidad que amplían el conjunto de candidatas evaluadas, no como un mecanismo de stacking — ver ADR-027.
- **Extiende** `promotions.rules` (jsonb, Fase 1) con un nuevo `kind: "campaña"`, mismo patrón que ya usan `"temporada"` y `"volumen"`.
- Comunicación proactiva de promociones es un cambio de comportamiento del orquestador (Fase 4), no solo de la tool — el LLM sigue sin poder anunciar un descuento sin que la tool ya lo haya calculado (principio rector de `contratos-tools.md` se mantiene).

## Contenido de esta fase

- [adrs/ADR-027-elegibilidad-multidimension-y-clasificacion-cliente.md](./adrs/ADR-027-elegibilidad-multidimension-y-clasificacion-cliente.md) — esquema de elegibilidad, cómo conviven con "no combinar", y cómo se deriva la clasificación de cliente.

## Dependencias

**Fase 14** (`ally_id`/`category_id` deben existir) y **Fase 15/16** (la clasificación de cliente necesita historial de `orders` ya estable).

## Riesgos

- Comunicar la promoción "proactivamente" puede chocar con el guardrail de no inventar descuentos si el orquestador la menciona antes de una llamada real a `aplicar_promocion` — el LLM solo la anuncia después de la llamada, nunca antes.
- La clasificación automática de cliente puede generar disputas de negocio ("¿por qué no soy 'fiel' todavía?") — el umbral debe ser configurable por tenant y validarse con datos reales, mismo criterio pendiente que el umbral de "monto alto" de Fase 7.

## Definición de terminado

- [ ] Una promoción exclusiva de un aliado (ej. "Ramos", 10%) solo aplica a productos de ese aliado, verificado con un producto de otro aliado en la misma cotización.
- [ ] Una promoción de campaña con `once_per_customer` no se vuelve a aplicar al mismo cliente en una segunda conversación.
- [ ] El agente menciona una promoción activa al detectar interés en la categoría correspondiente, antes del cierre del pedido, en al menos un escenario del golden set de la Fase 9.

Esta es la última fase de la cadena estrictamente secuencial 13→14→15→16→17. Las Fases 18, 19 y 20 pueden ejecutarse en paralelo con esta y entre sí.
