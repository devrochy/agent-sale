import { withTransaction } from "../../shared/db/index.js";

export interface RecomendarProductoInput {
  context?: string;
  product_id?: string | null;
}

export interface RecommendationOutput {
  product_id: string;
  variant_id: string;
  name: string;
  price: number;
  reason: string;
}

const RECOMMENDATION_LIMIT = 5;

interface VariantRow {
  product_id: string;
  variant_id: string;
  name: string;
  price: string;
}

/**
 * Tool recomendar_producto — implementa solo la ruta de reglas de
 * complementariedad de tool-recomendar-producto.md. La ruta de similitud
 * por embeddings (pgvector) queda pendiente a propósito: no hay proveedor
 * de embeddings elegido (decisión de costo/cuenta análoga a la del LLM,
 * ver ADR-010) ni ningún producto tiene `embedding` poblado — agregar esa
 * ruta ahora sería código que nunca podría ejercitarse de verdad.
 *
 * Las categorías complementarias (Fase 14, ver ADR-026) viven en
 * `category_complements` — reemplaza el mapa `COMPLEMENTARY_CATEGORIES`
 * que antes vivía hardcodeado en este archivo: ahora es una tabla
 * administrable desde el panel (`/admin/categorias`), no una constante que
 * solo un desarrollador podía cambiar. Cuando falta un product_id de
 * referencia, el producto no tiene `category_id`, o su categoría no tiene
 * complementos configurados, se devuelve una lista vacía en vez de
 * inventar un fallback a medias.
 */
export async function recomendarProducto(
  input: RecomendarProductoInput,
): Promise<{ recommendations: RecommendationOutput[] }> {
  return withTransaction(async (client) => {
    if (!input.product_id) {
      return { recommendations: [] };
    }

    const reference = await client.query<{ category_id: string | null; name: string }>(
      `SELECT category_id, name FROM products WHERE id = $1`,
      [input.product_id],
    );
    const referenceProduct = reference.rows[0];
    if (!referenceProduct?.category_id) {
      return { recommendations: [] };
    }

    const complements = await client.query<{ complementary_category_id: string }>(
      `SELECT complementary_category_id FROM category_complements WHERE category_id = $1`,
      [referenceProduct.category_id],
    );
    if (complements.rows.length === 0) {
      return { recommendations: [] };
    }
    const complementaryCategoryIds = complements.rows.map((row) => row.complementary_category_id);

    const result = await client.query<VariantRow>(
      `SELECT p.id AS product_id, pv.id AS variant_id, p.name, pv.price
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       JOIN inventory i ON i.variant_id = pv.id
       WHERE p.category_id = ANY($1) AND pv.active = true AND i.stock_quantity > 0 AND p.id != $2
       LIMIT $3`,
      [complementaryCategoryIds, input.product_id, RECOMMENDATION_LIMIT],
    );

    return {
      recommendations: result.rows.map((row) => ({
        product_id: row.product_id,
        variant_id: row.variant_id,
        name: row.name,
        price: Number(row.price),
        reason: `Frecuentemente comprado junto con ${referenceProduct.name}`,
      })),
    };
  });
}
