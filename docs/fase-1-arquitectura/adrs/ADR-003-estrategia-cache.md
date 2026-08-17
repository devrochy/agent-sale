# ADR-003: Estrategia de caché

## Estado
Aceptado.

## Contexto
Consultar Postgres directamente en cada turno de conversación para leer el catálogo/inventario es costoso en latencia y en carga de base de datos a escala de miles de conversaciones simultáneas. Además, el inventario de ForMotos vive hoy en Google Sheets, cuya sincronización no es instantánea.

## Decisión
Usar **Redis como caché del catálogo/inventario**, con invalidación por evento: cuando el proceso de sincronización (Sheets → Postgres, o la fuente que corresponda en el futuro) detecta un cambio, invalida la entrada correspondiente en caché en vez de esperar un TTL genérico.

Se documenta explícitamente el desfase aceptado: máximo 5 minutos entre un cambio real de stock y su reflejo en las respuestas del agente (ver criterios de éxito en [Fase 0](../../fase-0-descubrimiento.md)).

Adicionalmente, se usa **prompt caching de Claude** para el system prompt y el catálogo que se envía como contexto, reduciendo el costo por conversación al no reprocesar información estática en cada turno.

## Consecuencias
- El módulo de Catálogo/Inventario debe implementar invalidación por evento, no solo lectura de caché — es más trabajo que un TTL simple, pero evita responder con stock desactualizado de forma silenciosa.
- El diseño de `inventory.source` (ver [modelo-datos.md](../modelo-datos.md)) permite cambiar la fuente real sin afectar la capa de caché.
