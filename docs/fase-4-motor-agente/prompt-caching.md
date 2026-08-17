# Estrategia de Prompt Caching

## Por qué
El prompt caching es la principal palanca de costo del agente (ver estimación en [ADR-008](./adrs/ADR-008-modelo-claude.md)): sin él, cada turno de conversación paga el precio completo por reprocesar el system prompt y las definiciones de tools, que son idénticos en cada llamada.

## Qué se cachea
- **Definiciones de tools** (las 6 tools de la Fase 1) — fijas, no cambian entre turnos ni entre tenants (el esquema es el mismo; solo los datos que devuelven cambian).
- **System prompt — hasta tres bloques, hasta tres breakpoints**: un bloque **compartido** (persona del agente, reglas de negocio generales, escalamiento — byte-idéntico para todos los tenants, Fase 11.4 extendida, ver [ADR-021](../fase-11-panel-admin-dashboard/adrs/ADR-021-tono-personalizable-cache-jerarquico.md)), un bloque de **tono de voz**, configurable por tenant entre 3 variantes fijas (Cálido/Formal/Divertido), y un tercer bloque opcional de **voz de marca + RAG institucional** (misión/visión/valores, Fase 20, ver [ADR-030](../fase-20-voz-marca-rag/adrs/ADR-030-rag-institucional-tercer-bloque-cache-y-diagnostico-bug.md)) que solo se agrega si el negocio configuró algo. Cada bloque presente se marca con su propio `cache_control: {"type": "ephemeral"}` — son checkpoints de prefijo independientes (invalidar uno no invalida los anteriores). Como solo hay 3 variantes fijas de tono (no texto libre por tenant), el segundo breakpoint también se comparte entre todos los tenants que eligen el mismo tono; el tercero, al ser texto libre por negocio, no se comparte entre tenants (mismo trade-off que ADR-030 documenta y acepta).

Como el orden de renderizado de la API es `tools → system → messages`, un breakpoint al final del último bloque de system presente cachea **tools + todos los bloques de system hasta ahí** en una sola entrada; cada breakpoint anterior cachea su propio prefijo por separado. La API de Anthropic admite hasta 4 breakpoints en total — con los 3 bloques actuales queda 1 libre para uso futuro.

## Qué NO se cachea (va después del breakpoint)
- El catálogo completo de ForMotos **no** se embebe en el system prompt — son 300+ productos, y cambiaría en cada actualización de inventario, invalidando el caché constantemente. El catálogo se consulta bajo demanda vía la tool `consultar_inventario` (Fase 1), no como contexto estático.
- El historial de la conversación y el mensaje nuevo del cliente (ver [memoria-conversacional.md](./memoria-conversacional.md)) — cambian en cada turno por definición.

## TTL
Se usa el TTL por defecto de 5 minutos (`ephemeral`, sin especificar `ttl`), no el de 1 hora. Con ~430 conversaciones/mes reales pero concentradas en horario comercial, el tráfico dentro de una misma conversación normalmente llega en menos de 5 minutos entre turnos — suficiente para mantener el caché caliente durante una conversación activa, sin pagar el doble de costo de escritura que exige el TTL de 1 hora. Se revisita si en producción se observan muchas escrituras de caché por conversaciones con pausas largas entre mensajes.

## Verificación
Cada respuesta de Claude incluye en `usage`:
- `cache_creation_input_tokens` — tokens escritos a caché (costo ~1,25×).
- `cache_read_input_tokens` — tokens leídos desde caché (costo ~0,1×).

Estos valores se registran en `audit_log` (o en una métrica agregada, ver Fase 8) por cada llamada — si `cache_read_input_tokens` es consistentemente cero, es señal de un invalidador silencioso (ej. el system prompt cambiando por accidente entre llamadas) y debe investigarse antes de asumir que el caching está funcionando.

## Riesgo a vigilar: invalidadores silenciosos
Cada bloque de system debe ser **byte-idéntico** entre llamadas para que su breakpoint funcione (el bloque compartido, siempre; el bloque de tono, entre llamadas que usan la misma variante). Esto implica una regla de diseño: no interpolar fecha/hora, IDs de sesión, ni ningún valor variable dentro del texto de ningún bloque de system — cualquier contexto dinámico (ej. "son las 3pm, fuera de horario") debe ir en los `messages`, no en `system`. Por esto mismo el tono es un selector de 3 variantes fijas, no texto libre por tenant — texto libre haría que cada tenant tuviera un bloque distinto, sin reuso posible entre tenants.

## Qué no cubre este documento
- Los "mid-conversation system messages" (inyectar instrucciones sin invalidar caché) son una función disponible solo en Opus 4.8, no en Sonnet 5 (modelo elegido en el ADR-008) — no se diseña esa capacidad para este proyecto por ahora.
