# ADR-013: Mecanismo de carga de catálogo para el piloto

## Estado
Aceptado.

## Contexto
[sincronizacion-inventario.md](../../fase-5-catalogo-inventario/sincronizacion-inventario.md) (Fase 5) diseñó una sincronización periódica desde Google Sheets (fuente actual de ForMotos) hacia Postgres, con adaptador intercambiable. **Ese diseño nunca se implementó en código** — `src/domains/catalog/README.md` lo deja explícito. Lo que sí se construyó, fuera de ese plan original, fue un panel admin (`src/admin/adminPanel.ts`, PR #26) para cargar productos manualmente con imagen y descripción, más un script de siembra (`scripts/seed-catalogo-prueba.ts`) usado para pruebas.

Antes de arrancar el piloto con el catálogo real de ForMotos (~300+ productos, Fase 0) hay que decidir con cuál de los dos mecanismos se entra: implementar el sync con Sheets ya diseñado, o formalizar el panel admin como el mecanismo real.

## Opciones consideradas

1. **Implementar el sync con Google Sheets** como estaba diseñado en la Fase 5. Evita que ForMotos tenga que aprender una herramienta nueva (siguen editando su Sheet de siempre), pero agrega trabajo nuevo (adaptador, job periódico, manejo de fallos que no vacíe el catálogo) que no se hizo durante la Fase 5 y ahora compite con el resto del alcance de la Fase 9.
2. **Formalizar el panel admin ya construido** como el mecanismo real de carga para el piloto. Ya existe y ya soporta imagen/descripción (más que lo que pedía el diseño original de Sheets). Requiere que alguien (el dueño de ForMotos o el equipo) cargue el catálogo inicial a mano una vez, y mantenga altas/bajas de producto ahí en vez de en su Sheet — fricción de adopción nueva para el negocio piloto, que hoy edita su Sheet directamente.

## Decisión
**Usar el panel admin (opción 2) para el piloto**, y dejar el sync con Sheets del diseño de Fase 5 explícitamente pausado, no descartado. Razones: (a) ya está construido y probado, mientras que el sync con Sheets es trabajo nuevo sin empezar; (b) con 1-2 tenants piloto el volumen de altas/bajas de catálogo es bajo, no justifica automatizar la sincronización todavía — mismo criterio de no construir para un problema que no demostró ser un cuello de botella real; (c) la carga inicial del catálogo de ~300 productos de ForMotos se hace una vez, a mano o con un script de importación puntual (no recurrente) usando el mismo panel/tablas.

La fricción de que ForMotos deje de editar su Sheet y pase a usar el panel es un riesgo de adopción real (ver riesgos de esta fase en el [README](../README.md)) — se debe validar explícitamente con el dueño del negocio antes de comprometer esta decisión, no asumir que la acepta sin preguntar.

## Consecuencias
- El diseño de `sincronizacion-inventario.md` (Fase 5) queda como referencia para revisitar si el piloto demuestra que la carga manual es un cuello de botella real (ej. ForMotos actualiza precios/stock varias veces por día y el panel resulta más lento que su flujo actual con Sheets).
- La carga inicial del catálogo real de ForMotos es un ítem explícito de [pendientes-pre-piloto.md](../pendientes-pre-piloto.md), no automático.
- Si en el futuro se suma un segundo tenant piloto con una fuente de inventario distinta (no Sheets), esta decisión se revisita — el adaptador intercambiable de la Fase 5 seguía siendo la idea correcta para ese escenario, solo que no era prioritario para el primer piloto de un solo tenant.
