# Fase 14 — Esquema de Catálogo Extendido (Aliados, Categorías Jerárquicas, Variantes)

Estado: **completa** (PRs #54 y #55, 2026-08-03)

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

- [x] `allies`, `product_categories` (auto-referenciada), `category_complements` y `product_variants` creadas (migraciones 0039-0045) con backfill verificado sin pérdida de datos sobre el catálogo de prueba reescrito (`scripts/seed-catalogo-prueba.ts`, 100 productos/104 variantes/22 categorías), incluyendo el caso real de 4 niveles ("Para motos › Otros para motos › Iluminación › Exploradoras").
- [x] `consultar_inventario`, `generar_cotizacion` y `crear_pedido` operando sobre `variant_id`, verificado manualmente de punta a punta contra un producto real con 3 variantes de talla (agrupación correcta por `product_id`, resolución correcta del `variant_id` elegido).
- [x] Panel admin (`/admin/aliados`, `/admin/categorias`) permite crear/editar/activar-desactivar aliados y nodos del árbol de categorías, marcar categorías complementarias, y asignar aliado/categoría a un producto existente desde `/admin/productos` — sin tocar código, verificado end-to-end.

Implementado en 2 PRs: [#54](https://github.com/devrochy/agent-sale/pull/54) (esquema + tools de dominio + tests) y [#55](https://github.com/devrochy/agent-sale/pull/55) (panel admin de aliados/categorías).

## Extensión post-fase (fuera del alcance original)

Al probar manualmente el panel quedó claro que faltaba algo que la propuesta original de la Fase 14 (`PROPUESTA_V2.md` §3.10.1) ya pedía y no se había construido, más un par de necesidades reales nuevas del negocio:

- **Alta y edición completa de productos** desde `/admin/productos` — Fase 14 (PR #55) solo dejó *asignar* aliado/categoría a un producto ya existente, explícitamente fuera de su alcance en ese momento. Ahora la tabla lista por producto genérico (no por variante) y un modal permite crear/editar nombre, descripción, imagen, aliado, categoría y la lista completa de variantes (SKU/talla/color/precio/stock/activa).
- **Edición rápida por doble clic** en Productos y Aliados — los campos simples de la tabla se ven como texto plano hasta que se hace doble clic, sin necesidad de abrir el modal para un cambio chico.
- **"Ver productos" por aliado** (`/admin/aliados` → `/admin/productos?allyId=`) — esto es exactamente lo que pedía `PROPUESTA_V2.md` §3.10.1 ("permite listar productos por aliado") y había quedado sin construir en el PR #55.
- **Carga masiva de productos por CSV**, desde un modal en `/admin/productos` (sin navegar a una página aparte) — un admin sube, en nombre de un aliado, un archivo con columnas `sku,name,price,stock` (+ `talla,color` opcionales); antes de escribir nada muestra una previsualización editable fila por fila (crear / actualizar stock / error) donde se elige la categoría de cada producto nuevo (el CSV no trae categoría — se asigna acá, nunca queda sin definir) y recién con "Confirmar carga" se aplica: actualiza precio/stock si el SKU ya existe (nunca reasigna aliado/categoría/nombre de un producto existente), agrupa varias filas nuevas con el mismo `name` como variantes de un solo producto (misma categoría, la de la primera fila del grupo), o crea el producto si es nuevo. Ejemplo de archivo: `docs/fase-14-catalogo-extendido/ejemplo-importacion-csv.csv`. **Pendiente para un incremento futuro, no descartado**: un portal/login propio para que el aliado externo suba su archivo directamente, sin pasar por un admin del panel.

Implementado en 2 PRs adicionales: [#56](https://github.com/devrochy/agent-sale/pull/56) (gestión completa de productos) y [#57](https://github.com/devrochy/agent-sale/pull/57) (importación masiva por CSV, sobre esa base).

Siguiente paso: [Fase 15 — Datos de Cliente y Flujo de Pedidos Extendido](../fase-15-datos-cliente-flujo-pedidos/README.md), que depende de este esquema.
