import { withTransaction } from "./withTransaction.js";

/**
 * Árbol de categorías de producto (Fase 14, ver ADR-026) — profundidad
 * libre vía `parent_id` autoreferenciado, reemplaza `products.category`
 * (texto plano). `category_complements` reemplaza el mapa hardcodeado
 * `COMPLEMENTARY_CATEGORIES` que antes vivía en `recomendarProducto.ts`.
 */
export interface CategoryRecord {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  active: boolean;
}

interface CategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  active: boolean;
}

function mapCategoryRow(row: CategoryRow): CategoryRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    sortOrder: row.sort_order,
    active: row.active,
  };
}

export async function listCategories(): Promise<CategoryRecord[]> {
  return withTransaction(async (client) => {
    const result = await client.query<CategoryRow>(
      `SELECT id, parent_id, name, sort_order, active FROM product_categories ORDER BY sort_order, name`,
    );
    return result.rows.map(mapCategoryRow);
  });
}

export async function createCategory(
  name: string,
  parentId: string | null,
  sortOrder: number,
): Promise<string> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO product_categories (parent_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id`,
      [parentId, name, sortOrder],
    );
    return result.rows[0]!.id;
  });
}

export async function updateCategory(
  categoryId: string,
  input: { name: string; parentId: string | null; sortOrder: number },
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE product_categories SET name = $1, parent_id = $2, sort_order = $3 WHERE id = $4`,
      [input.name, input.parentId, input.sortOrder, categoryId],
    );
  });
}

export async function setCategoryActive(categoryId: string, active: boolean): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`UPDATE product_categories SET active = $1 WHERE id = $2`, [active, categoryId]);
  });
}

/** IDs de las categorías marcadas como complementarias de `categoryId` (una sola dirección, ver `setComplements`). */
export async function listComplementIds(categoryId: string): Promise<string[]> {
  return withTransaction(async (client) => {
    const result = await client.query<{ complementary_category_id: string }>(
      `SELECT complementary_category_id FROM category_complements WHERE category_id = $1`,
      [categoryId],
    );
    return result.rows.map((row) => row.complementary_category_id);
  });
}

/** Todas las relaciones de complementariedad, en una sola query — evita N+1 al renderizar la tabla completa de categorías. */
export async function listAllComplementPairs(): Promise<{ categoryId: string; complementaryCategoryId: string }[]> {
  return withTransaction(async (client) => {
    const result = await client.query<{ category_id: string; complementary_category_id: string }>(
      `SELECT category_id, complementary_category_id FROM category_complements`,
    );
    return result.rows.map((row) => ({
      categoryId: row.category_id,
      complementaryCategoryId: row.complementary_category_id,
    }));
  });
}

/**
 * Reemplaza por completo el conjunto de complementarias de `categoryId`
 * (mismo criterio "sin merge" que `saveBehaviorConfig`) — se siembran
 * ambas direcciones explícitamente (A↔B), para que `recomendarProducto.ts`
 * pueda consultar con un solo `WHERE category_id = $1` sin un `OR`
 * simétrico en cada query.
 */
export async function setComplements(
  categoryId: string,
  complementaryCategoryIds: string[],
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM category_complements WHERE category_id = $1 OR complementary_category_id = $1`,
      [categoryId],
    );
    const uniqueIds = [...new Set(complementaryCategoryIds)].filter((id) => id !== categoryId);
    for (const complementaryId of uniqueIds) {
      await client.query(
        `INSERT INTO category_complements (category_id, complementary_category_id) VALUES ($1, $2), ($2, $1)
         ON CONFLICT DO NOTHING`,
        [categoryId, complementaryId],
      );
    }
  });
}
