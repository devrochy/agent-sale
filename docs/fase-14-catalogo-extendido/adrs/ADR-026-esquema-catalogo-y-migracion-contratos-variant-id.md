# ADR-026: Esquema de catálogo extendido (aliados, categorías, variantes) y migración de contratos a `variant_id`

## Estado
Aceptada (2026-08-03, al iniciar la implementación de la Fase 14).

**Corrección respecto a la redacción original:** este ADR se escribió antes del retiro de multi-tenancy (ADR-032, Fase 13). Los bloques de esquema de abajo ya no llevan `tenant_id` — agent-sale es mono-tenant desde `migrations/0036_drop_multitenancy.cjs`, y esa columna no se reintroduce solo para el catálogo. También se agregó una decisión que la redacción original no contemplaba: `recomendar_producto` no usa embeddings (nunca se implementó, pese a que `products.embedding` existe desde la Fase 5) — usa un mapa hardcodeado `COMPLEMENTARY_CATEGORIES` que compara el texto de `products.category`, y ese mapa se rompe en cuanto `category` pasa a ser `category_id` (FK). Ver "Sobre la recomendación de productos complementarios" más abajo.

## Contexto

`products` (`migrations/0005_products_inventory.cjs`) modela hoy un producto plano: `sku`, `name`, `category` (texto libre), `price`, `embedding`, sin variantes ni jerarquía ni proveedor/aliado. `PROPUESTA_V2.md` §3.10.1 reporta un caso real de ForMotos con 4 niveles de categoría (`Para motos › Otros para motos › Iluminación › Exploradoras`), que un esquema fijo de columnas (`category`/`subcategory`/`sub_subcategory`) no puede representar sin forzar niveles vacíos o inventados. También reporta la necesidad de variantes (talla/color en cascos y guantes) y de un concepto de "aliado" (proveedor externo tipo "Ramos") para anclar promociones exclusivas (ver Fase 17).

La propuesta original (§3.10.1) ya trae un esquema de punto de partida, marcado explícitamente como "para que Claude Code la valide/ajuste" — esta ADR confirma ese esquema con un ajuste (ver "Aliado por defecto" abajo) y decide la estrategia de migración de los contratos de tools que hoy referencian `product_id` directamente.

## Opciones consideradas

### Sobre categorías

1. **Columnas fijas (`category`/`subcategory`/`sub_subcategory`)** — descartada: el caso real de 4 niveles ya la rompe, y un nicho con 2 niveles dejaría columnas vacías sin necesidad.
2. **Árbol auto-referenciado (`product_categories.parent_id`)** — elegida: profundidad libre, un solo esquema sirve para un nicho de 2 niveles y otro de 5 sin cambios de schema.

### Sobre variantes

1. **Agregar `talla`/`color` como columnas nullable en `products`** — descartada: no todos los productos usan esos atributos (un aceite no tiene talla/color, podría tener "presentación"), forzaría columnas que no aplican a la mayoría del catálogo.
2. **`product_variants` con `attributes jsonb`** — elegida, mismo patrón ya usado en `promotions.rules` (Fase 1) para datos de forma variable.

### Sobre el aliado por defecto

`PROPUESTA_V2.md` deja abierto si `products.ally_id` es obligatorio con un aliado "genérico" para productos propios de ForMotos, o nullable. Se decide **obligatorio con aliado genérico**: se crea un `allies` sembrado (`name: "Catálogo propio"`) para todo producto que no venga de un tercero. Esto simplifica el código de promociones (Fase 17) — nunca hay que distinguir "promoción por aliado" de "promoción para productos sin aliado" como dos casos separados, siempre hay un `ally_id`.

### Sobre la recomendación de productos complementarios

`src/domains/commerce/recomendarProducto.ts` resuelve hoy sus sugerencias con un mapa hardcodeado en código (`COMPLEMENTARY_CATEGORIES`, ej. `{casco: ["guantes","chaqueta"], ...}`) comparando directamente el texto de `products.category`. Al reemplazar `category` (texto) por `category_id` (FK a `product_categories`), ese mapa deja de tener sentido.

1. **Mantener un mapa hardcodeado, ahora por `category_id`** — descartada: sigue siendo una regla de negocio que solo un desarrollador puede cambiar, exactamente la limitación que esta fase busca resolver para categorías/aliados en el panel.
2. **Tabla `category_complements` administrable desde el panel** — elegida: `(category_id uuid FK, complementary_category_id uuid FK, PRIMARY KEY(category_id, complementary_category_id))`, editable desde la misma sección de categorías que ya construye esta fase (`/admin/categorias`, PR 2). Se siembran ambas direcciones explícitamente al marcar dos categorías como complementarias (evita depender de un `OR` simétrico en cada query).

## Decisión

### Esquema

```sql
allies (
  id uuid PK, name text, contact_info text,
  active boolean DEFAULT true, created_at timestamptz
)

product_categories (
  id uuid PK,
  parent_id uuid FK → product_categories.id NULL,  -- null = nivel raíz
  name text, sort_order int, active boolean DEFAULT true
)

category_complements (
  category_id uuid FK → product_categories.id,
  complementary_category_id uuid FK → product_categories.id,
  PRIMARY KEY (category_id, complementary_category_id)
)

products (
  id uuid PK,
  ally_id uuid FK → allies.id NOT NULL,             -- default: aliado genérico
  category_id uuid FK → product_categories.id,      -- nodo hoja
  name text, description text, embedding vector, has_variants boolean,
  updated_at timestamptz
  -- sku y price se retiran de products, viven en product_variants
)

product_variants (
  id uuid PK, product_id uuid FK → products.id,
  sku text unique, attributes jsonb DEFAULT '{}', price numeric(12,2),
  active boolean DEFAULT true
)
```

Todo producto tiene al menos una variante — incluso los que hoy no tienen talla/color reciben una única fila en `product_variants` con `attributes = '{}'`, para no bifurcar la lógica de precio/stock entre "productos con variante" y "productos sin variante" en ningún punto del código.

### Migración de tablas existentes

`inventory.product_id`, `quote_items.product_id`, `order_items.product_id` → `variant_id`. No hay catálogo real cargado en ninguna base al momento de implementar esta fase (confirmado con el negocio) — solo el catálogo de prueba de `scripts/seed-catalogo-prueba.ts` — así que no hace falta un backfill de producción cuidadoso, pero se mantiene el mismo criterio de pasos separados por prudencia y porque es el patrón que ya usa el proyecto (migraciones nunca se editan):
1. Por cada `products` existente, crear una `product_variants` con el `sku`/`price` que hoy vive en `products`, `attributes = '{}'`.
2. Actualizar `inventory`/`quote_items`/`order_items` para apuntar a esa variante recién creada.
3. En una migración separada de los pasos 1-2, eliminar `sku`/`price`/`category` de `products` (para poder revertir sin pérdida si algo sale mal en desarrollo).

### Migración de contratos de tools

`docs/fase-1-arquitectura/contratos-tools.md` se actualiza (en el árbol de v2, no editando el archivo de v1 en esta etapa — ver instrucción 5 de `PROPUESTA_V2.md`; la actualización real del documento de v1 ocurre en la fusión de la Etapa 2):

- `consultar_inventario.output.matches[]` cambia `product_id` por `variant_id` (mantiene `product_id` como referencia al genérico, para que el LLM pueda agrupar variantes del mismo producto en la respuesta al cliente).
- `generar_cotizacion.input.items[].product_id` cambia a `variant_id`.
- `crear_pedido` hereda `variant_id` desde la cotización, sin cambio de forma en su propio input.

### Comportamiento nuevo del agente: preguntar variante antes de cotizar

Cuando `consultar_inventario` devuelve un producto con más de una `variant` activa, el orquestador no permite pasar a `generar_cotizacion` sin que la conversación haya resuelto cuál variante — instrucción explícita en el bloque compartido de `systemPrompt.ts` (no en el bloque de tono de ADR-021, esto es comportamiento, no voz).

## Consecuencias

- Toda promoción de Fase 17 puede anclarse a `ally_id`, `category_id` (con o sin hijas) o `product_id`/`variant_id`, sin campos booleanos sueltos en `products`.
- El costo de este cambio es alto en superficie (4 tablas nuevas — `allies`, `product_categories`, `category_complements`, `product_variants` —, 3 tablas existentes migradas, 4-5 contratos de tools) pero se paga una sola vez — se ejecuta antes que Fase 15/16/17 precisamente para no migrar dos veces la misma tabla.
- Un aliado "genérico" significa que `allies` nunca está vacío mientras haya catálogo cargado — simplifica cualquier query de listado "productos por aliado" (siempre hay al menos un grupo).
- `recomendar_producto` deja de depender de una constante en código para sus sugerencias — el negocio puede ajustar qué categorías se recomiendan entre sí sin un deploy.
