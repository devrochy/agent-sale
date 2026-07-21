# Caché de Inventario

Implementación concreta de [ADR-003](../fase-1-arquitectura/adrs/ADR-003-estrategia-cache.md) (Fase 1) para el catálogo/inventario, sobre Redis (ya presente en la arquitectura como cola de mensajes, ver [ADR-002](../fase-1-arquitectura/adrs/ADR-002-broker-colas.md)).

## Estructura de claves

```
inventory:{tenant_id}:product:{product_id}       → JSON del producto + stock
inventory:{tenant_id}:search:{término_normalizado} → lista de product_id que matchean
```

Cada clave incluye `tenant_id` explícitamente en el nombre — no basta con que Postgres tenga RLS; la caché es una capa aparte y debe mantener el mismo aislamiento por tenant desde su diseño (coherente con [ADR-004](../fase-1-arquitectura/adrs/ADR-004-multi-tenancy-rls.md)).

## Invalidación por evento (no TTL genérico)

Cuando el [adaptador de sincronización](./sincronizacion-inventario.md) actualiza un producto en Postgres, invalida explícitamente:
1. La clave `inventory:{tenant_id}:product:{product_id}` de ese producto.
2. Cualquier clave `inventory:{tenant_id}:search:*` que pudiera haber cacheado ese producto como resultado (en la práctica, más simple invalidar todas las claves `search:*` del tenant en cada sincronización, dado que corre solo cada 5 minutos — no es un costo alto).

Esto evita el problema de un TTL genérico: con TTL fijo, el agente podría servir un precio o stock desactualizado durante toda la ventana del TTL, incluso si el dato cambió hace un segundo. Con invalidación por evento, el desfase máximo real es el intervalo de sincronización (5 minutos, definido en [sincronizacion-inventario.md](./sincronizacion-inventario.md)), no el TTL de caché.

## Qué pasa si Redis no está disponible

Mismo principio que en [idempotencia.md](../fase-3-whatsapp-gateway/idempotencia.md) (Fase 3): si la caché no responde, la tool `consultar_inventario` cae a consultar Postgres directamente (más lento, pero correcto) en vez de fallar la respuesta al cliente. La caché es una optimización de costo/latencia, nunca la única fuente de verdad — Postgres sigue siendo la fuente de verdad real.

## Qué no cubre este documento
- Configuración real de TTL/memoria de Redis — implementación, no arquitectura.
- Métricas de hit rate de la caché — corresponde a la Fase 8 (Observabilidad).
