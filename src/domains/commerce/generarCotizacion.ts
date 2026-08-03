import { withTransaction } from "../../shared/db/index.js";

export interface CotizacionItemInput {
  product_id: string;
  quantity: number;
}

export interface GenerarCotizacionInput {
  items: CotizacionItemInput[];
}

export interface CotizacionItemOutput {
  product_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface GenerarCotizacionOutput {
  quote_id: string;
  items: CotizacionItemOutput[];
  subtotal: number;
  status: "draft";
}

interface ProductStockRow {
  id: string;
  name: string;
  price: string;
  stock: string;
}

/**
 * Tool generar_cotizacion (ver docs/fase-1-arquitectura/contratos-tools.md
 * y docs/fase-6-dominio-comercial/flujo-cotizacion-pedido.md). Vuelve a
 * validar precio y stock real de cada item contra Postgres — nunca confía
 * en que el LLM haya propuesto bien un precio o que el stock alcance. No
 * aplica promociones (eso es aplicar_promocion). Las cotizaciones son
 * inmutables: no hay operación de "editar", un cambio de items genera un
 * quote_id nuevo.
 */
export async function generarCotizacion(
  conversationId: string,
  customerId: string,
  input: GenerarCotizacionInput,
): Promise<GenerarCotizacionOutput> {
  if (input.items.length === 0) {
    throw new Error("La cotización necesita al menos un producto.");
  }

  return withTransaction(async (client) => {
    const items: CotizacionItemOutput[] = [];

    for (const item of input.items) {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new Error(`Cantidad inválida para el producto ${item.product_id}: ${item.quantity}`);
      }

      const result = await client.query<ProductStockRow>(
        `SELECT p.id, p.name, p.price, COALESCE(i.stock_quantity, 0) AS stock
         FROM products p
         LEFT JOIN inventory i ON i.product_id = p.id
         WHERE p.id = $1`,
        [item.product_id],
      );
      const product = result.rows[0];
      if (!product) {
        throw new Error(`Producto no encontrado: ${item.product_id}`);
      }

      const stock = Number(product.stock);
      if (stock < item.quantity) {
        throw new Error(
          `Stock insuficiente para ${product.name}: pediste ${item.quantity}, hay ${stock} disponibles.`,
        );
      }

      const unitPrice = Number(product.price);
      items.push({
        product_id: product.id,
        name: product.name,
        quantity: item.quantity,
        unit_price: unitPrice,
        line_total: unitPrice * item.quantity,
      });
    }

    const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);

    const quote = await client.query<{ id: string }>(
      `INSERT INTO quotes (conversation_id, customer_id, subtotal, discount, total, status)
       VALUES ($1, $2, $3, 0, $3, 'draft')
       RETURNING id`,
      [conversationId, customerId, subtotal],
    );
    const quoteId = quote.rows[0]!.id;

    for (const item of items) {
      await client.query(
        `INSERT INTO quote_items (quote_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)`,
        [quoteId, item.product_id, item.quantity, item.unit_price],
      );
    }

    return { quote_id: quoteId, items, subtotal, status: "draft" };
  });
}
