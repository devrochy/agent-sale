# ADR-035: CRUD de promociones en el panel, modal compartido y puntos de entrada distribuidos

## Estado
Propuesta.

## Contexto

`promotions` existe desde la Fase 6 y ganó columnas de elegibilidad multi-dimensión en la Fase 17 (`ally_id`, `category_id`, `include_child_categories`, `product_id`, `variant_id`, `eligible_segments`), pero nunca tuvo una interfaz de administración: hoy se siembra directo en la base, igual que hicieron los tests de `aplicarPromocion.test.ts` y el seed manual usado para probar la Fase 17 por WhatsApp. Rob pide un CRUD completo en el panel, con un modal reutilizable, y la posibilidad de crear una promoción sin salir de la pantalla de Productos, Aliados, Categorías o Leads.

## Decisión

### Página central `/admin/promociones`

Nueva entrada de navegación "Promociones" en el grupo "Catálogo" del rail (`src/admin/adminPanel.ts`, junto a Productos/Pedidos/Aliados/Categorías) — es el único lugar donde se ven **todas** las promociones a la vez, con el mismo patrón de tabla que el resto del panel (`data-table`, buscador, paginación cliente). Columnas: Tipo, Descripción, Dimensión (resuelta a texto legible, ver abajo), Segmentos elegibles, Vigencia, Estado (chip activa/inactiva), acciones (editar, activar/desactivar). Sin permiso nuevo: se accede igual que Productos/Aliados/Categorías hoy, sin gate de `admin_permissions` (esas páginas no están gateadas por permiso, solo por sesión autenticada — no hay precedente de un permiso de "gestiona catálogo" en el modelo de la Fase 13, y no se introduce uno para esta fase por consistencia).

"Dimensión" en la tabla se resuelve así (ninguna columna nueva, se calcula al leer):
- Sin `ally_id`/`category_id`/`product_id`/`variant_id` → "Todo el catálogo".
- `ally_id` seteado → "Aliado: {nombre}".
- `category_id` seteado → "Categoría: {nombre}" + " (+ subcategorías)" si `include_child_categories`.
- `product_id`/`variant_id` seteado → "Producto: {nombre}" (+ variante si aplica).

### Modal compartido, no una página de formulario aparte

Un solo diálogo `promocion-dialog` (mismo patrón que `productoDialogHtml`/`categoriaEditDialogHtml` — función que genera el HTML del `<dialog class="modal">` parametrizada por si es alta o edición), reutilizado desde los 5 puntos de entrada (lista central + 4 secciones). Campos:

- **Tipo** (`temporada` | `volumen` | `campaña`) — el motor de `aplicarPromocion.ts` ya distingue estos 3 `kind` desde la Fase 17; el formulario muestra/oculta campos según el tipo elegido con el mismo patrón de JS vanilla que ya usa el diálogo de importación CSV de Fase 14 para su previsualización editable (sin dependencia nueva de frontend).
- **Descripción/etiqueta** (`rules.label`) y **% de descuento** (`rules.discount_pct`).
- **Vigencia** (`valid_from`/`valid_to`, opcionales — una campaña de bienvenida sin fecha de fin es válida hoy).
- **Una sola dimensión de elegibilidad por formulario**: selector "Todo el catálogo" / "Un aliado" / "Una categoría" / "Un producto o variante puntual", cada uno revela el selector correspondiente (dropdown de aliados/árbol de categorías/buscador de producto). El motor (`esElegible()`, ADR-027) ya soporta combinar varias dimensiones a la vez con lógica `AND` porque todas las columnas son independientes, pero **esta fase no expone esa combinación en el formulario** — se limita a una dimensión por promoción para no complicar la UI con un caso que nadie pidió; queda documentado como ampliación posible, no como límite del motor.
- **Segmentos elegibles** (checkboxes, los 5 valores de [ADR-036](./ADR-036-clasificacion-cliente-5-niveles-y-rediseno-leads.md); sin selección = aplica a cualquier segmento, igual que hoy).
- **Una vez por cliente** (checkbox, solo visible si Tipo = campaña; mapea a `rules.once_per_customer`).
- **Activa** (toggle, default `true` al crear).

### Rutas

- `GET /admin/promociones` — lista.
- `POST /admin/promociones` — alta (valida y arma `rules` jsonb según el tipo, igual que ya hace `crearColaborador`/`crearAliado` con sus respectivos payloads).
- `POST /admin/promociones/:id` — edición.
- `POST /admin/promociones/:id/activar` y `/desactivar` — mismo patrón que ya existe para aliados/categorías/productos, en vez de un DELETE real (una promoción usada en `promotion_redemptions` o referenciada por `quotes.applied_promotion_id` no debe poder borrarse en duro).

### Puntos de entrada distribuidos

Cada uno abre el mismo `promocion-dialog`, en modo alta, con la dimensión correspondiente **pre-cargada y bloqueada** (el selector de dimensión no se muestra; ya viene resuelto):

- **Productos** (`renderProductosPage`, junto al botón de editar de cada fila, línea ~3355): botón "Agregar promoción" → dimensión producto, `product_id` de la fila; si el producto tiene variantes, un selector adicional opcional de variante puntual (dejar vacío = aplica a todas las variantes del producto).
- **Aliados** (`renderAliadosPage`, línea ~4050): botón "Agregar promoción" → dimensión aliado, `ally_id` de la fila.
- **Categorías** (`renderCategoriasPage`, línea ~4308): botón "Agregar promoción" → dimensión categoría, `category_id` de la fila, con "incluir subcategorías" marcado por defecto (mismo default que ya usa la columna en BD).
- **Leads** (`renderLeadsPage`): botón "Crear promoción para este segmento" → **no** fija `ally_id`/`category_id`/`product_id` — en su lugar pre-marca, en el checkbox de segmentos elegibles, el segmento actual del cliente de esa fila (ver limitación abajo).

### Limitación explícita: Leads no puede crear una promoción 1:1

`promotions` no tiene ni tendrá en esta fase una columna `customer_id` — el pedido original ("registrar promociones... para cliente en la sección de leads") se interpreta como "poder generar rápido una promoción dirigida al segmento de ese cliente", no una promoción exclusiva de un solo cliente. Se decide así por dos razones: (1) el motor de elegibilidad (ADR-027) fue diseñado deliberadamente alrededor de segmentos, no de identidades individuales, y añadir una dimensión 1:1 exigiría además decidir cómo interactúa con "no se combinan promociones" cuando dos clientes del mismo segmento tienen cada uno su propia promoción individual; (2) no hay pedido de negocio que hoy necesite descuentos personalizados por cliente puntual, solo por perfil de cliente. El modal, al abrirse desde Leads, muestra un texto explícito: *"Esta promoción aplicará a todos los clientes clasificados como '{segmento}', no solo a {nombre del cliente}"* — para que el operador nunca asuma un alcance que el sistema no ofrece. Si el negocio pide más adelante una promoción verdaderamente individual (ej. un cupón de compensación por una queja), es una ADR y una columna nuevas, no una extensión silenciosa de esta.

## Consecuencias

- No se necesita ninguna migración sobre `promotions` — el esquema de la Fase 17 ya alcanza. Solo hace falta la UI y las rutas.
- El formulario no permite combinar dimensiones aunque el motor sí podría — limitación de producto, no de arquitectura; documentado para no repetir la pregunta si se vuelve a evaluar.
- La entrada desde Leads queda atada al segmento, no al cliente — riesgo de expectativa incorrecta si el texto de advertencia del modal no es lo bastante visible; a revisar en la implementación real con una captura de pantalla antes de darlo por cerrado.
