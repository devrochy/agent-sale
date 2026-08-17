# Fase 5 — Dominio de Catálogo e Inventario en Tiempo Real

Estado: **completada** (rama `feature/fase-5-catalogo-inventario`)

Referencia: [MASTER_PLAN.md](../../MASTER_PLAN.md#fase-5--dominio-de-catálogo-e-inventario-en-tiempo-real) · [Fase 4 — Motor del Agente](../fase-4-motor-agente/README.md)

Documentación de diseño, mismo criterio que las fases anteriores — sin código todavía. Esta fase construye directamente sobre las tablas `products`/`inventory` y el [ADR-003](../fase-1-arquitectura/adrs/ADR-003-estrategia-cache.md) ya definidos en la Fase 1 — aquí se concreta el mecanismo real, no se rediseña el modelo de datos.

## Contenido de esta fase

- [sincronizacion-inventario.md](./sincronizacion-inventario.md) — sincronización desde Google Sheets (fuente actual de ForMotos) a Postgres, con adaptador intercambiable y manejo de fallos que nunca vacía el catálogo.
- [cache-inventario.md](./cache-inventario.md) — estructura de claves Redis por tenant, invalidación por evento (no TTL genérico), y fallback a Postgres si Redis falla.
- [tool-consultar-inventario.md](./tool-consultar-inventario.md) — cómo la tool de la Fase 1 se conecta a esta capa: búsqueda por texto + fallback semántico, manejo de coincidencias ambiguas.

## Definición de terminado

- [x] Mecanismo de sincronización de inventario documentado, con fuente intercambiable (Sheets hoy) y frecuencia definida (5 minutos, alineada al desfase máximo de la Fase 0).
- [x] Capa de caché con invalidación por evento diseñada sobre la infraestructura ya elegida (Redis, ADR-002/003).
- [x] Tool `consultar_inventario` (Fase 1) conectada al flujo de búsqueda real.
- [x] Modelo de variantes decidido: cada variante (talla/color) es una fila separada en `products`, con su propio `product_id`, `sku`, precio y stock independiente.

**Fase 5 completada, sin pendientes.** Siguiente paso: Fase 6 — Dominio Comercial (Cotizaciones, Pedidos, Promociones, Recomendaciones).
