import { withTransaction } from "./withTransaction.js";

/**
 * Productos y sus variantes (Fase 14 + extensión post-fase, ver
 * docs/fase-14-catalogo-extendido/README.md#extensión-post-fase) — CRUD
 * completo, a diferencia de `consultarInventario.ts`/`generarCotizacion.ts`
 * (esos son de lectura/venta para el LLM, no de administración). Todo
 * producto tiene al menos una variante (ver ADR-026); `has_variants` se
 * recalcula siempre a partir de cuántas variantes activas tiene, nunca es
 * un campo que se setea a mano desde el panel.
 */
export interface VariantInput {
  sku: string;
  attributes: Record<string, unknown>;
  price: number;
  stock: number;
}

export interface VariantUpdateInput extends VariantInput {
  /** `null` = variante nueva (se inserta); con valor = variante existente (se actualiza). */
  id: string | null;
  active: boolean;
}

export interface VariantDetail {
  id: string;
  sku: string;
  attributes: Record<string, unknown>;
  price: number;
  stock: number;
  active: boolean;
}

export interface ProductSummary {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  allyId: string;
  allyName: string;
  categoryId: string | null;
  categoryName: string | null;
  variantCount: number;
  minPrice: number;
  maxPrice: number;
  totalStock: number;
}

export interface ProductDetail {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  allyId: string;
  categoryId: string | null;
  variants: VariantDetail[];
}

interface ProductSummaryRow {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  ally_id: string;
  ally_name: string;
  category_id: string | null;
  category_name: string | null;
  variant_count: string;
  min_price: string;
  max_price: string;
  total_stock: string;
}

/** Solo cuenta variantes activas — un producto con todas sus variantes desactivadas no debe ofrecerse ni listarse, mismo criterio que `consultarInventario.ts`. */
export async function listProductsSummary(
  filters: { allyId?: string; categoryId?: string } = {},
): Promise<ProductSummary[]> {
  return withTransaction(async (client) => {
    const params: string[] = [];
    let allyFilter = "";
    if (filters.allyId) {
      params.push(filters.allyId);
      allyFilter = `AND p.ally_id = $${params.length}`;
    }
    let categoryFilter = "";
    if (filters.categoryId) {
      params.push(filters.categoryId);
      categoryFilter = `AND p.category_id = $${params.length}`;
    }

    const result = await client.query<ProductSummaryRow>(
      `SELECT p.id, p.name, p.description, p.image_url,
              p.ally_id, a.name AS ally_name, p.category_id, pc.name AS category_name,
              COUNT(pv.id) AS variant_count,
              MIN(pv.price) AS min_price, MAX(pv.price) AS max_price,
              COALESCE(SUM(i.stock_quantity), 0) AS total_stock
       FROM products p
       JOIN allies a ON a.id = p.ally_id
       LEFT JOIN product_categories pc ON pc.id = p.category_id
       JOIN product_variants pv ON pv.product_id = p.id AND pv.active = true
       LEFT JOIN inventory i ON i.variant_id = pv.id
       WHERE true ${allyFilter} ${categoryFilter}
       GROUP BY p.id, p.name, p.description, p.image_url, p.ally_id, a.name, p.category_id, pc.name
       ORDER BY pc.name, p.name`,
      params,
    );

    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      imageUrl: row.image_url,
      allyId: row.ally_id,
      allyName: row.ally_name,
      categoryId: row.category_id,
      categoryName: row.category_name,
      variantCount: Number(row.variant_count),
      minPrice: Number(row.min_price),
      maxPrice: Number(row.max_price),
      totalStock: Number(row.total_stock),
    }));
  });
}

/** Trae TODAS las variantes (activas e inactivas) — el modal de edición necesita poder reactivar una variante desactivada. */
export async function getProductDetail(productId: string): Promise<ProductDetail | null> {
  return withTransaction(async (client) => {
    const product = await client.query<{
      id: string;
      name: string;
      description: string | null;
      image_url: string | null;
      ally_id: string;
      category_id: string | null;
    }>(`SELECT id, name, description, image_url, ally_id, category_id FROM products WHERE id = $1`, [productId]);
    const row = product.rows[0];
    if (!row) {
      return null;
    }

    const variants = await client.query<{
      id: string;
      sku: string;
      attributes: Record<string, unknown>;
      price: string;
      stock: string;
      active: boolean;
    }>(
      `SELECT pv.id, pv.sku, pv.attributes, pv.price, COALESCE(i.stock_quantity, 0) AS stock, pv.active
       FROM product_variants pv
       LEFT JOIN inventory i ON i.variant_id = pv.id
       WHERE pv.product_id = $1
       ORDER BY pv.sku`,
      [productId],
    );

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      imageUrl: row.image_url,
      allyId: row.ally_id,
      categoryId: row.category_id,
      variants: variants.rows.map((v) => ({
        id: v.id,
        sku: v.sku,
        attributes: v.attributes,
        price: Number(v.price),
        stock: Number(v.stock),
        active: v.active,
      })),
    };
  });
}

export async function createProduct(input: {
  name: string;
  description: string | null;
  imageUrl: string | null;
  allyId: string;
  categoryId: string | null;
  variants: VariantInput[];
}): Promise<string> {
  return withTransaction(async (client) => {
    const hasVariants = input.variants.length > 1;
    const product = await client.query<{ id: string }>(
      `INSERT INTO products (name, description, image_url, ally_id, category_id, has_variants)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.name, input.description, input.imageUrl, input.allyId, input.categoryId, hasVariants],
    );
    const productId = product.rows[0]!.id;

    for (const variant of input.variants) {
      const insertedVariant = await client.query<{ id: string }>(
        `INSERT INTO product_variants (product_id, sku, attributes, price) VALUES ($1, $2, $3, $4) RETURNING id`,
        [productId, variant.sku, JSON.stringify(variant.attributes), variant.price],
      );
      await client.query(`INSERT INTO inventory (variant_id, stock_quantity) VALUES ($1, $2)`, [
        insertedVariant.rows[0]!.id,
        variant.stock,
      ]);
    }

    return productId;
  });
}

/**
 * Reemplaza los campos del producto y aplica los cambios de variantes en
 * un solo paso: cada `variant.id` presente se actualiza, cada uno en
 * `null` se inserta como variante nueva — así el modal puede mezclar
 * "editar variantes existentes" y "agregar variantes nuevas" en el mismo
 * submit. No borra variantes que dejaron de venir en el input: se
 * desactivan explícitamente desde el modal (`active: false`), nunca se
 * eliminan filas (mismo criterio de "no premature deletion" que ya sigue
 * el resto del panel con admins/aliados/categorías).
 */
export async function updateProduct(
  productId: string,
  input: {
    name: string;
    description: string | null;
    imageUrl: string | null;
    allyId: string;
    categoryId: string | null;
    variants: VariantUpdateInput[];
  },
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE products SET name = $1, description = $2, image_url = $3, ally_id = $4, category_id = $5 WHERE id = $6`,
      [input.name, input.description, input.imageUrl, input.allyId, input.categoryId, productId],
    );

    for (const variant of input.variants) {
      let variantId = variant.id;
      if (variantId) {
        await client.query(
          `UPDATE product_variants SET sku = $1, attributes = $2, price = $3, active = $4 WHERE id = $5`,
          [variant.sku, JSON.stringify(variant.attributes), variant.price, variant.active, variantId],
        );
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO product_variants (product_id, sku, attributes, price, active) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [productId, variant.sku, JSON.stringify(variant.attributes), variant.price, variant.active],
        );
        variantId = inserted.rows[0]!.id;
      }

      const updatedStock = await client.query(`UPDATE inventory SET stock_quantity = $1 WHERE variant_id = $2`, [
        variant.stock,
        variantId,
      ]);
      if (updatedStock.rowCount === 0) {
        await client.query(`INSERT INTO inventory (variant_id, stock_quantity) VALUES ($1, $2)`, [
          variantId,
          variant.stock,
        ]);
      }
    }

    const activeCount = await client.query<{ count: string }>(
      `SELECT COUNT(*) FROM product_variants WHERE product_id = $1 AND active = true`,
      [productId],
    );
    await client.query(`UPDATE products SET has_variants = $1 WHERE id = $2`, [
      Number(activeCount.rows[0]!.count) > 1,
      productId,
    ]);
  });
}

/** Busca una variante por SKU exacto — usado por la carga masiva de CSV para decidir alta vs. actualización. */
/** Cantidad de productos por aliado — usado para el chip "N productos" de `/admin/aliados`, no cuenta variantes ni filtra por activas (es un conteo simple de administración, no de catálogo vendible). */
export async function countProductsPerAlly(): Promise<Record<string, number>> {
  return withTransaction(async (client) => {
    const result = await client.query<{ ally_id: string; count: string }>(
      `SELECT ally_id, COUNT(*) AS count FROM products GROUP BY ally_id`,
    );
    return Object.fromEntries(result.rows.map((row) => [row.ally_id, Number(row.count)]));
  });
}

/** Mismo criterio que `countProductsPerAlly` pero por categoría (solo cuenta productos con `category_id` asignado) — usado en el árbol de `/admin/categorias`. */
export async function countProductsPerCategory(): Promise<Record<string, number>> {
  return withTransaction(async (client) => {
    const result = await client.query<{ category_id: string; count: string }>(
      `SELECT category_id, COUNT(*) AS count FROM products WHERE category_id IS NOT NULL GROUP BY category_id`,
    );
    return Object.fromEntries(result.rows.map((row) => [row.category_id, Number(row.count)]));
  });
}

/** Todas las variantes activas de todos los productos, con su `productId` — usado por el selector producto→variante del modal de promociones (Fase 23), que filtra en el cliente sin round-trip por producto elegido. */
export async function listAllVariantsForPicker(): Promise<{ id: string; sku: string; productId: string }[]> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string; sku: string; product_id: string }>(
      `SELECT id, sku, product_id FROM product_variants WHERE active = true ORDER BY sku`,
    );
    return result.rows.map((row) => ({ id: row.id, sku: row.sku, productId: row.product_id }));
  });
}

export async function findVariantBySku(sku: string): Promise<{ id: string; productId: string } | null> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string; product_id: string }>(
      `SELECT id, product_id FROM product_variants WHERE sku = $1`,
      [sku],
    );
    const row = result.rows[0];
    return row ? { id: row.id, productId: row.product_id } : null;
  });
}

/** Clasificación en lote de SKUs para la previsualización de la carga masiva de CSV — una sola consulta en vez de un `findVariantBySku` por fila. */
export async function classifySkus(
  skus: string[],
): Promise<
  Map<string, { productName: string; price: number; stock: number; description: string | null; imageUrl: string | null }>
> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      sku: string;
      name: string;
      price: string;
      stock: string;
      description: string | null;
      image_url: string | null;
    }>(
      `SELECT pv.sku, p.name, pv.price, COALESCE(i.stock_quantity, 0) AS stock, p.description, p.image_url
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN inventory i ON i.variant_id = pv.id
       WHERE pv.sku = ANY($1)`,
      [skus],
    );
    const map = new Map<
      string,
      { productName: string; price: number; stock: number; description: string | null; imageUrl: string | null }
    >();
    for (const row of result.rows) {
      map.set(row.sku, {
        productName: row.name,
        price: Number(row.price),
        stock: Number(row.stock),
        description: row.description,
        imageUrl: row.image_url,
      });
    }
    return map;
  });
}

/** Actualiza solo precio y stock de una variante existente — la carga masiva de CSV nunca reasigna aliado/categoría/nombre de un producto ya existente. */
export async function updateVariantStockAndPrice(variantId: string, price: number, stock: number): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`UPDATE product_variants SET price = $1 WHERE id = $2`, [price, variantId]);
    const updated = await client.query(`UPDATE inventory SET stock_quantity = $1 WHERE variant_id = $2`, [
      stock,
      variantId,
    ]);
    if (updated.rowCount === 0) {
      await client.query(`INSERT INTO inventory (variant_id, stock_quantity) VALUES ($1, $2)`, [variantId, stock]);
    }
  });
}
