# Fase 14 — Esquema de Catálogo Extendido (Aliados, Categorías Jerárquicas, Variantes)

Estado: **en diseño** (v2)

Referencia: [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md#fase-14--esquema-de-catálogo-extendido-aliados-categorías-jerárquicas-variantes) · [PROPUESTA_V2.md §3.10, §3.10.1](../../PROPUESTA_V2.md) · [Fase 1 — Arquitectura](../fase-1-arquitectura/README.md) · [Fase 5 — Catálogo e Inventario](../fase-5-catalogo-inventario/README.md) · [Fase 6 — Dominio Comercial](../fase-6-dominio-comercial/README.md)

Es, en palabras de la propia propuesta, "la parte de mayor cambio estructural" de todo v2: reemplaza `products.category` (texto plano, `migrations/0005_products_inventory.cjs`) por un árbol de categorías de profundidad libre, introduce `allies` como entidad propia, y separa el producto genérico (lo que el cliente busca) de sus variantes concretas (lo que tiene SKU/precio/stock real). Se ejecuta antes que cualquier otra fase de v2 que dependa de catálogo (15, 16, 17) porque todas asumen que `variant_id` ya existe.

## Relación con v1

- **Reescribe** el modelo de `products` de [`modelo-datos.md`](../fase-1-arquitectura/modelo-datos.md) (Fase 1) y los contratos `consultar_inventario`, `generar_cotizacion`, `crear_pedido` de [`contratos-tools.md`](../fase-1-arquitectura/contratos-tools.md) — no es una columna nueva, es un cambio de forma de la relación producto → SKU.
- **Toca la implementación** de Fase 5 (`consultar_inventario` sobre `products`/`inventory`) y Fase 6 (`generar_cotizacion`/`crear_pedido` sobre `quote_items`/`order_items`), sin cambiar sus objetivos de fase originales.
- No choca con ninguna ADR aceptada — `products.embedding` (pgvector, Fase 5) se mantiene sin cambios en el producto genérico, la recomendación por similitud sigue funcionando igual.

## Contenido de esta fase

- [adrs/ADR-026-esquema-catalogo-y-migracion-contratos-variant-id.md](./adrs/ADR-026-esquema-catalogo-y-migracion-contratos-variant-id.md) — esquema de `allies`/`product_categories`/`category_complements`/`product_variants`, estrategia de backfill sin pérdida de datos, y la migración de los contratos de tools a `variant_id`.
- [contratos-tools-v2.md](./contratos-tools-v2.md) — los contratos de `consultar_inventario`/`generar_cotizacion`/`crear_pedido`/`recomendar_producto`/`aplicar_promocion` ya migrados a `variant_id`.

## Riesgos

- Es la migración de mayor riesgo de todo v2 — toca `inventory`, `quote_items` y `order_items` con datos reales si el catálogo de ForMotos ya está cargado (ver [`pendientes-pre-piloto.md`](../fase-9-piloto-controlado/pendientes-pre-piloto.md) #5, mapeado en `MASTER_PLAN_V2.md`). Confirmado con el negocio al implementar: no había catálogo real cargado todavía, así que se recreó el esquema en vez de un backfill de producción.
- El agente debe aprender a preguntar talla/color antes de cotizar sin degradar el "camino feliz" ya validado en la Fase 0 — riesgo de regresión conversacional, no solo de datos. El escenario 9 ("variante ambigua") de `docs/fase-9-piloto-controlado/eval-suite.md` ya anticipaba este comportamiento — ese golden set no está implementado todavía (`eval/` no existe en el repo), así que no hay ningún test E2E que romper hoy; cuando se implemente, sus assertions deberían usar `variant_id` (no se edita ese documento v1 en esta etapa, ver instrucción 5 de `PROPUESTA_V2.md`).

## Definición de terminado

- [ ] `allies`, `product_categories` (auto-referenciada) y `product_variants` creadas con migración y backfill verificado sin pérdida de datos sobre el catálogo de prueba (`scripts/seed-catalogo-prueba.ts`), incluyendo un caso real de 4 niveles de categoría.
- [ ] `consultar_inventario`, `generar_cotizacion` y `crear_pedido` operando sobre `variant_id` en un flujo de prueba de punta a punta.
- [ ] Panel admin permite administrar el árbol de categorías y asignar aliado a un producto sin tocar código (sección nueva, construida sobre la misma base de componentes del panel que ya existe).

Siguiente paso: [Fase 15 — Datos de Cliente y Flujo de Pedidos Extendido](../fase-15-datos-cliente-flujo-pedidos/README.md), que depende de este esquema.
