# Fase 23 — CRUD de Promociones en el Panel y Clasificación Extendida de Clientes

Estado: **en diseño**

Referencia: [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md#fase-23--crud-de-promociones-en-el-panel-y-clasificación-extendida-de-clientes) · [Fase 6 — Motor de Promociones](../fase-6-dominio-comercial/motor-promociones.md) · [Fase 14 — Catálogo Extendido](../fase-14-catalogo-extendido/README.md) · [Fase 15 — Datos de Cliente](../fase-15-datos-cliente-flujo-pedidos/README.md) · [Fase 17 — Motor de Promociones Avanzado](../fase-17-motor-promociones-avanzado/README.md)

## Origen

A diferencia de las Fases 13-22, esta fase no viene de un bloque de `PROPUESTA_V2.md` §3 — nace de una petición directa de Rob al cerrar la Fase 17 (2026-08-04), al probar el motor de promociones por WhatsApp y notar que no existe ninguna forma de crear/editar promociones ni de ver la clasificación de un cliente sin tocar la base de datos a mano. La Fase 17 dejó esto **explícitamente fuera de alcance** (ver README de Fase 17, "Fuera de alcance") porque `PROPUESTA_V2.md` §3.7 no lo pedía; esta fase lo retoma como trabajo propio.

## Relación con v1/v2

- **Extiende** `promotions` (Fase 6, `migrations/0006_promotions.cjs`) y las columnas de elegibilidad multi-dimensión que ya agregó la Fase 17 (`migrations/0049`) — no se necesita ninguna columna nueva en `promotions` para el CRUD, el esquema ya soporta las 4 dimensiones que pide esta fase (aliado, categoría/subcategoría, producto/variante, campaña).
- **Reemplaza** la clasificación de 3 niveles de la Fase 17 (`clasificarCliente()` en `src/domains/commerce/aplicarPromocion.ts`) por una de 5 niveles — ver [ADR-036](./adrs/ADR-036-clasificacion-cliente-5-niveles-y-rediseno-leads.md) para la definición exacta y sus límites.
- **Extiende** la vista de Leads (Fase 11.2, `docs/fase-11-panel-admin-dashboard/conversaciones-leads-tickets.md`) con clasificación, control de bot por cliente y un modal de detalle/edición.
- **Reutiliza** el patrón de modal/diálogo ya validado en el panel (`data-open-dialog`, `<dialog class="modal">`, `src/admin/adminPanel.ts`) — mismo mecanismo que ya usan los diálogos de "Nuevo producto", "Nuevo aliado", "Nueva categoría" e "Importar CSV" de la Fase 14.
- **No depende** de la Fase 18 (Tickets y Conversaciones) — el control de bot por cliente que pide esta fase es un flag propio de `customers`, independiente del `conversations.bot_paused` que planea la Fase 18 (si ambos terminan existiendo, se combinan con `OR` en el mismo punto de chequeo de `consumer.ts`, no se excluyen).

## Contenido de esta fase

- [adrs/ADR-035-crud-promociones-panel-y-puntos-de-entrada.md](./adrs/ADR-035-crud-promociones-panel-y-puntos-de-entrada.md) — diseño del CRUD de promociones, el modal compartido y los 4 puntos de entrada distribuidos (Productos, Aliados, Categorías, Leads).
- [adrs/ADR-036-clasificacion-cliente-5-niveles-y-rediseno-leads.md](./adrs/ADR-036-clasificacion-cliente-5-niveles-y-rediseno-leads.md) — algoritmo de clasificación de 5 niveles, rediseño de la tabla de Leads, control de bot por cliente y modal de detalle/edición del lead.

## Dependencias

**Fase 14** (`ally_id`/`category_id`/`variant_id` ya deben existir), **Fase 15** (`customers.full_name`/`address`/`id_document`/`municipality`/`city` ya deben existir para el modal de detalle) y **Fase 17** (columnas de elegibilidad de `promotions` y la clasificación de 3 niveles que esta fase reemplaza).

## Riesgos

- La clasificación de 5 niveles introduce umbrales nuevos (intervalo entre compras, días de inactividad) sin datos reales de ForMotos todavía — mismo riesgo ya documentado en ADR-027 para "fiel", ahora extendido a 3 umbrales más. No se bloquea la fase por esto, pero los valores por defecto deben tratarse como provisionales.
- "Cliente fiel" tal como lo define el enunciado original (confianza, satisfacción, recomendación activa) no es medible con los datos que hoy existen en el sistema — ver la limitación documentada en [ADR-036](./adrs/ADR-036-clasificacion-cliente-5-niveles-y-rediseno-leads.md).
- El punto de entrada de promociones desde Leads no puede dirigirse a un cliente individual (`promotions` no tiene `customer_id`) — se resuelve dirigiendo la promoción al segmento del cliente, con una advertencia explícita en la UI para que el operador no asuma alcance 1:1. Ver [ADR-035](./adrs/ADR-035-crud-promociones-panel-y-puntos-de-entrada.md).

## Definición de terminado

- [ ] Un administrador puede crear, editar y activar/desactivar una promoción de cada una de las 4 dimensiones (aliado, categoría, producto/variante, campaña) desde `/admin/promociones`, sin tocar la base de datos.
- [ ] El botón "Agregar promoción" de una fila de Productos, Aliados y Categorías abre el mismo modal con la dimensión correspondiente pre-cargada y bloqueada.
- [ ] La tabla de Leads muestra clasificación (5 niveles) y un control de bot por cliente, ya sin la columna "Último mensaje", verificado contra clientes reales con distintos historiales de pedidos.
- [ ] El modal de detalle de un lead permite ver y editar nombre completo, dirección, cédula, municipio y ciudad, y los cambios se reflejan en `customers` sin afectar `delivery_*` (datos de un pedido en curso, Fase 15).
