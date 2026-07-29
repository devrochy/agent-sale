import { withTenant } from "../../shared/db/index.js";

export interface ConsultarInventarioInput {
  query?: string;
  sku?: string | null;
}

export interface ProductMatch {
  product_id: string;
  sku: string;
  name: string;
  price: number;
  stock: number;
  variants: string[];
  description: string | null;
  image_url: string | null;
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  price: string;
  stock: string;
  description: string | null;
  image_url: string | null;
}

/**
 * Tool consultar_inventario (ver docs/fase-1-arquitectura/contratos-tools.md).
 * `variants` queda vacío: agrupar variantes de un mismo producto base es
 * un detalle de la Fase 6 (dominio comercial), no de este incremento.
 */
export async function consultarInventario(
  tenantId: string,
  input: ConsultarInventarioInput,
): Promise<{ matches: ProductMatch[] }> {
  const rows = await withTenant(tenantId, async (client) => {
    if (input.sku) {
      const result = await client.query<ProductRow>(
        `SELECT p.id, p.sku, p.name, p.price, p.description, p.image_url,
                COALESCE(i.stock_quantity, 0) AS stock
         FROM products p
         LEFT JOIN inventory i ON i.product_id = p.id
         WHERE p.sku = $1`,
        [input.sku],
      );
      return result.rows;
    }

    const term = `%${input.query ?? ""}%`;
    const result = await client.query<ProductRow>(
      `SELECT p.id, p.sku, p.name, p.price, p.description, p.image_url,
              COALESCE(i.stock_quantity, 0) AS stock
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id
       WHERE p.name ILIKE $1 OR p.sku ILIKE $1
       LIMIT 10`,
      [term],
    );
    return result.rows;
  });

  return {
    matches: rows.map((row) => ({
      product_id: row.id,
      sku: row.sku,
      name: row.name,
      price: Number(row.price),
      stock: Number(row.stock),
      variants: [],
      description: row.description,
      image_url: row.image_url,
    })),
  };
}
