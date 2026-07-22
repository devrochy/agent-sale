import { withTenant } from "../../shared/db/index.js";

export interface RecomendarProductoInput {
  context?: string;
  product_id?: string | null;
}

export interface RecommendationOutput {
  product_id: string;
  name: string;
  price: number;
  reason: string;
}

/**
 * Reglas de complementariedad (ver
 * docs/fase-6-dominio-comercial/tool-recomendar-producto.md). El doc
 * plantea que esto viva como configuración ajustable por tenant sin
 * redeploy, pero el modelo de datos de la Fase 1 no tiene una tabla para
 * eso — por ahora es un mapa fijo en código para el catálogo real de
 * ForMotos; mover esto a una tabla configurable es un incremento futuro
 * si se suman tenants con categorías distintas.
 */
const COMPLEMENTARY_CATEGORIES: Record<string, string[]> = {
  casco: ["guantes", "chaqueta"],
  llanta: ["camara", "valvula"],
  guantes: ["casco"],
};

const RECOMMENDATION_LIMIT = 5;

interface ProductRow {
  id: string;
  name: string;
  price: string;
}

/**
 * Tool recomendar_producto — implementa solo la ruta de reglas de
 * complementariedad de tool-recomendar-producto.md. La ruta de similitud
 * por embeddings (pgvector) queda pendiente a propósito: no hay proveedor
 * de embeddings elegido (decisión de costo/cuenta análoga a la del LLM,
 * ver ADR-010) ni ningún producto tiene `embedding` poblado — agregar esa
 * ruta ahora sería código que nunca podría ejercitarse de verdad. Cuando
 * falta un product_id de referencia, o su categoría no tiene regla
 * configurada, se devuelve una lista vacía en vez de inventar un
 * fallback a medias.
 */
export async function recomendarProducto(
  tenantId: string,
  input: RecomendarProductoInput,
): Promise<{ recommendations: RecommendationOutput[] }> {
  return withTenant(tenantId, async (client) => {
    if (!input.product_id) {
      return { recommendations: [] };
    }

    const reference = await client.query<{ category: string | null; name: string }>(
      `SELECT category, name FROM products WHERE id = $1`,
      [input.product_id],
    );
    const referenceProduct = reference.rows[0];
    if (!referenceProduct?.category) {
      return { recommendations: [] };
    }

    const complementaryCategories = COMPLEMENTARY_CATEGORIES[referenceProduct.category];
    if (!complementaryCategories || complementaryCategories.length === 0) {
      return { recommendations: [] };
    }

    const result = await client.query<ProductRow>(
      `SELECT p.id, p.name, p.price
       FROM products p
       JOIN inventory i ON i.product_id = p.id
       WHERE p.category = ANY($1) AND i.stock_quantity > 0 AND p.id != $2
       LIMIT $3`,
      [complementaryCategories, input.product_id, RECOMMENDATION_LIMIT],
    );

    return {
      recommendations: result.rows.map((row) => ({
        product_id: row.id,
        name: row.name,
        price: Number(row.price),
        reason: `Frecuentemente comprado junto con ${referenceProduct.name}`,
      })),
    };
  });
}
