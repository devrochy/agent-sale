# Fase 6 — Dominio Comercial: Cotizaciones, Pedidos, Promociones, Recomendaciones

Estado: **completada** (rama `feature/fase-6-dominio-comercial`)

Referencia: [MASTER_PLAN.md](../../MASTER_PLAN.md#fase-6--dominio-comercial-cotizaciones-pedidos-promociones-recomendaciones) · [Fase 5 — Catálogo e Inventario](../fase-5-catalogo-inventario/README.md)

Documentación de diseño, mismo criterio que las fases anteriores. Construye sobre las tools y el modelo de datos ya definidos en la Fase 1 (`generar_cotizacion`, `aplicar_promocion`, `crear_pedido`, `recomendar_producto`, tablas `quotes`/`orders`/`promotions`) — aquí se concreta el comportamiento real de cada una.

## Contenido de esta fase

- [motor-promociones.md](./motor-promociones.md) — implementación del motor de reglas para las promociones reales de ForMotos (temporada + volumen), con la regla "no combinar, elegir la mejor" como comportamiento por defecto.
- [flujo-cotizacion-pedido.md](./flujo-cotizacion-pedido.md) — flujo completo encadenado de las 3 tools comerciales, con las dos capas de protección contra pedidos duplicados.
- [tool-recomendar-producto.md](./tool-recomendar-producto.md) — combinación de reglas de complementariedad (venta cruzada) + similitud de embeddings (pgvector), con filtro de stock obligatorio.

## Definición de terminado

- [x] Tool `generar_cotizacion` → `aplicar_promocion` → `crear_pedido` diseñadas como flujo encadenado, sin duplicados (idempotencia de transporte + de negocio).
- [x] Motor de reglas de promociones definido explícitamente (no delegado al LLM), cubriendo temporada, volumen, y beneficio no monetario (producto/servicio gratis).
- [x] Tool `recomendar_producto` conectada a pgvector + reglas simples de complementariedad, con filtro de stock.
- [x] Tablas de cotizaciones/pedidos/promociones ya cubiertas por el modelo de datos de la Fase 1 (`quotes`, `quote_items`, `orders`, `order_items`, `promotions`), con RLS ya definido en [ADR-004](../fase-1-arquitectura/adrs/ADR-004-multi-tenancy-rls.md).
- [x] Confirmado con ForMotos: las promociones **no se combinan** — se aplica la de mayor beneficio para el cliente.

**Fase 6 completada, sin pendientes.** Siguiente paso: Fase 7 — Escalamiento a Humano (Handoff).
