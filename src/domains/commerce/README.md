# domains/commerce

Cotizaciones, pedidos, promociones y recomendaciones: tools `generar_cotizacion`, `aplicar_promocion`, `crear_pedido`, `recomendar_producto` (ver `docs/fase-6-dominio-comercial/`).

- `generarCotizacion.ts` — valida precio y stock reales de cada item contra Postgres, crea `quotes`/`quote_items`. No aplica promociones.
- `aplicarPromocion.ts` — motor de reglas de `promotions.rules` (temporada + volumen, incluye beneficio no monetario "producto gratis"); nunca combina promociones, elige siempre la de mayor beneficio para el cliente.
- `crearPedido.ts` — convierte una cotización en pedido. El `idempotency_key` lo genera el orquestador (hash de `quote_id` + `message_sid`), nunca lo propone el LLM (ver `orchestrator/toolDefinitions.ts`). Protegido además porque una cotización solo puede convertirse en un pedido (0..1).
- `recomendarProducto.ts` — solo implementa la ruta de reglas de complementariedad por categoría con filtro de stock obligatorio. La ruta de similitud por embeddings (`pgvector`) queda pendiente: no hay proveedor de embeddings elegido (ver [ADR-010](../../../docs/fase-4-motor-agente/adrs/ADR-010-abstraccion-proveedor-llm.md), misma categoría de decisión).

No se importa directamente desde otros `domains/*` — solo a través de `orchestrator`.
