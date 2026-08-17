# domains/catalog

Catálogo e inventario. `consultarInventario.ts` implementa la tool `consultar_inventario` (lectura directa de `products`/`inventory`) desde el incremento de Fase 4. Sincronización con la fuente real (hoy Google Sheets) y caché en Redis llegan con el incremento de Fase 5 (ver `docs/fase-5-catalogo-inventario/`).

No se importa directamente desde otros `domains/*` — solo a través de `orchestrator`.
