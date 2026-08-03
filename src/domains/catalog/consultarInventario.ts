import { withTransaction } from "../../shared/db/index.js";

export interface ConsultarInventarioInput {
  query?: string;
  sku?: string | null;
}

export interface ProductMatch {
  product_id: string;
  variant_id: string;
  sku: string;
  name: string;
  attributes: Record<string, unknown>;
  price: number;
  stock: number;
  description: string | null;
  image_url: string | null;
}

interface MatchRow {
  product_id: string;
  variant_id: string;
  sku: string;
  name: string;
  attributes: Record<string, unknown>;
  price: string;
  stock: string;
  description: string | null;
  image_url: string | null;
}

const MATCH_COLUMNS = `
  p.id AS product_id, pv.id AS variant_id, pv.sku, p.name, pv.attributes, pv.price,
  COALESCE(i.stock_quantity, 0) AS stock, p.description, p.image_url
`;
const MATCH_FROM = `
  FROM product_variants pv
  JOIN products p ON p.id = pv.product_id
  LEFT JOIN inventory i ON i.variant_id = pv.id
`;

/**
 * Tool consultar_inventario (ver docs/fase-14-catalogo-extendido/contratos-tools-v2.md).
 * `matches[]` sigue siendo plano — una fila por variante (SKU real), no por
 * producto genérico agrupado: el LLM es quien agrupa variantes del mismo
 * producto (mismo `product_id`) al responder, ver ADR-026. Solo variantes
 * activas: una variante desactivada no debe ofrecerse ni cotizarse.
 */
export async function consultarInventario(
  input: ConsultarInventarioInput,
): Promise<{ matches: ProductMatch[] }> {
  const rows = await withTransaction(async (client) => {
    if (input.sku) {
      const result = await client.query<MatchRow>(
        `SELECT ${MATCH_COLUMNS} ${MATCH_FROM} WHERE pv.sku = $1 AND pv.active = true`,
        [input.sku],
      );
      return result.rows;
    }

    const term = `%${input.query ?? ""}%`;
    const result = await client.query<MatchRow>(
      `SELECT ${MATCH_COLUMNS} ${MATCH_FROM}
       WHERE pv.active = true AND (p.name ILIKE $1 OR pv.sku ILIKE $1)
       LIMIT 10`,
      [term],
    );
    return result.rows;
  });

  return {
    matches: rows.map((row) => ({
      product_id: row.product_id,
      variant_id: row.variant_id,
      sku: row.sku,
      name: row.name,
      attributes: row.attributes,
      price: Number(row.price),
      stock: Number(row.stock),
      description: row.description,
      image_url: row.image_url,
    })),
  };
}
