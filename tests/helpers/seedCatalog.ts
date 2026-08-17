import type { Pool } from "pg";

export interface SeedProductInput {
  sku: string;
  name: string;
  price: number;
  stock: number;
  categoryId?: string | null;
}

export interface SeedProductResult {
  productId: string;
  variantId: string;
}

/**
 * Siembra un producto + su única variante (SKU/precio reales viven en
 * `product_variants` desde la Fase 14, ver ADR-026) + `inventory`, para
 * tests de integración — reemplaza el INSERT inline de
 * `products`/`inventory` que cada archivo de test reimplementaba por su
 * cuenta antes de esta fase. Usa el aliado genérico ya sembrado por la
 * migración 0039 ("Catálogo propio") — asume que las migraciones ya
 * corrieron, igual que el resto de la suite asume que el esquema existe.
 */
export async function seedProduct(pool: Pool, input: SeedProductInput): Promise<SeedProductResult> {
  const ally = await pool.query<{ id: string }>(`SELECT id FROM allies ORDER BY created_at ASC LIMIT 1`);
  const allyId = ally.rows[0]?.id;
  if (!allyId) {
    throw new Error("No hay ningún aliado sembrado — corré las migraciones antes de los tests.");
  }

  const product = await pool.query<{ id: string }>(
    `INSERT INTO products (ally_id, category_id, name) VALUES ($1, $2, $3) RETURNING id`,
    [allyId, input.categoryId ?? null, input.name],
  );
  const productId = product.rows[0]!.id;

  const variant = await pool.query<{ id: string }>(
    `INSERT INTO product_variants (product_id, sku, price) VALUES ($1, $2, $3) RETURNING id`,
    [productId, input.sku, input.price],
  );
  const variantId = variant.rows[0]!.id;

  await pool.query(`INSERT INTO inventory (variant_id, stock_quantity) VALUES ($1, $2)`, [
    variantId,
    input.stock,
  ]);

  return { productId, variantId };
}

/** Borra lo sembrado por `seedProduct` — orden child→parent (inventory → product_variants → products). */
export async function deleteProduct(pool: Pool, productId: string): Promise<void> {
  await pool.query(
    `DELETE FROM inventory WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)`,
    [productId],
  );
  await pool.query(`DELETE FROM product_variants WHERE product_id = $1`, [productId]);
  await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
}
