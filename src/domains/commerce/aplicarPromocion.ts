import { withTransaction } from "../../shared/db/index.js";

export interface AplicarPromocionInput {
  quote_id: string;
  // Aceptado por compatibilidad con el contrato funcional de la Fase 1,
  // pero sin efecto: docs/fase-6-dominio-comercial/motor-promociones.md no
  // define un sistema de códigos (promotions no tiene columna `code`) —
  // la evaluación es siempre automática (temporada + volumen).
  promo_code?: string | null;
}

export interface AplicarPromocionOutput {
  quote_id: string;
  promotion_applied: { id: string; kind: "temporada" | "volumen"; description: string } | null;
  subtotal: number;
  discount: number;
  total: number;
}

type VolumeTier =
  | { min: number; max?: number; discount_pct: number }
  | { min: number; max?: number; free_item_sku: string };

interface VolumeRules {
  kind: "volumen";
  tiers: VolumeTier[];
}

interface SeasonRules {
  kind: "temporada";
  label: string;
  discount_pct: number;
}

interface PromotionRow {
  id: string;
  type: "temporada" | "volumen";
  rules: VolumeRules | SeasonRules;
}

interface BestPromotion {
  id: string;
  kind: "temporada" | "volumen";
  description: string;
  benefitValue: number;
  monetaryDiscount: number;
  freeItemSku?: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Tool aplicar_promocion (ver docs/fase-6-dominio-comercial/motor-promociones.md).
 * La tool evalúa, nunca el LLM: recorre promotions.rules, calcula el
 * beneficio real de cada promoción activa y aplica la de mayor beneficio
 * para el cliente — nunca se combinan/apilan promociones.
 *
 * Devuelve `subtotal` explícitamente (no solo `discount`/`total`) para que
 * el guardrail de precios (priceGuardrail.ts, que solo verifica montos
 * contra las tools llamadas en el turno actual) no marque como
 * "no verificable" un subtotal real que el LLM repite al mostrar el
 * desglose subtotal → descuento → total — antes escalaba una conversación
 * válida por esto (guardrail_precio) cada vez que el cliente pedía una
 * promoción sobre una cotización ya generada.
 */
export async function aplicarPromocion(input: AplicarPromocionInput): Promise<AplicarPromocionOutput> {
  return withTransaction(async (client) => {
    const quoteResult = await client.query<{ id: string; subtotal: string }>(
      `SELECT id, subtotal FROM quotes WHERE id = $1`,
      [input.quote_id],
    );
    const quote = quoteResult.rows[0];
    if (!quote) {
      throw new Error(`Cotización no encontrada: ${input.quote_id}`);
    }
    const subtotal = Number(quote.subtotal);

    const totalQtyResult = await client.query<{ total_quantity: string }>(
      `SELECT COALESCE(SUM(quantity), 0) AS total_quantity FROM quote_items WHERE quote_id = $1`,
      [input.quote_id],
    );
    const totalQuantity = Number(totalQtyResult.rows[0]!.total_quantity);

    const promotionsResult = await client.query<PromotionRow>(
      `SELECT id, type, rules FROM promotions
       WHERE active = true
         AND (
           type = 'volumen'
           OR (
             type = 'temporada'
             AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
             AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
           )
         )`,
    );

    let best: BestPromotion | null = null;

    for (const promo of promotionsResult.rows) {
      if (promo.type === "volumen") {
        const rules = promo.rules as VolumeRules;
        const tier = rules.tiers.find(
          (t) => totalQuantity >= t.min && (t.max === undefined || totalQuantity <= t.max),
        );
        if (!tier) {
          continue;
        }

        if ("discount_pct" in tier) {
          const amount = round2((subtotal * tier.discount_pct) / 100);
          if (!best || amount > best.benefitValue) {
            best = {
              id: promo.id,
              kind: "volumen",
              description: `Descuento por volumen (${tier.discount_pct}% por ${totalQuantity} unidades)`,
              benefitValue: amount,
              monetaryDiscount: amount,
            };
          }
        } else {
          const freeVariant = await client.query<{ name: string; price: string }>(
            `SELECT p.name, pv.price
             FROM product_variants pv
             JOIN products p ON p.id = pv.product_id
             WHERE pv.sku = $1 AND pv.active = true`,
            [tier.free_item_sku],
          );
          const variant = freeVariant.rows[0];
          if (!variant) {
            continue;
          }
          const benefitValue = Number(variant.price);
          if (!best || benefitValue > best.benefitValue) {
            best = {
              id: promo.id,
              kind: "volumen",
              description: `Producto gratis por volumen: ${variant.name}`,
              benefitValue,
              monetaryDiscount: 0,
              freeItemSku: tier.free_item_sku,
            };
          }
        }
      } else {
        const rules = promo.rules as SeasonRules;
        const amount = round2((subtotal * rules.discount_pct) / 100);
        if (!best || amount > best.benefitValue) {
          best = {
            id: promo.id,
            kind: "temporada",
            description: `${rules.label} (${rules.discount_pct}% de descuento)`,
            benefitValue: amount,
            monetaryDiscount: amount,
          };
        }
      }
    }

    if (!best) {
      return {
        quote_id: input.quote_id,
        promotion_applied: null,
        subtotal,
        discount: 0,
        total: subtotal,
      };
    }

    const total = round2(subtotal - best.monetaryDiscount);

    await client.query(`UPDATE quotes SET discount = $1, total = $2 WHERE id = $3`, [
      best.monetaryDiscount,
      total,
      input.quote_id,
    ]);

    if (best.freeItemSku) {
      const freeVariant = await client.query<{ id: string }>(
        `SELECT id FROM product_variants WHERE sku = $1 AND active = true`,
        [best.freeItemSku],
      );
      await client.query(
        `INSERT INTO quote_items (quote_id, variant_id, quantity, unit_price)
         VALUES ($1, $2, 1, 0)`,
        [input.quote_id, freeVariant.rows[0]!.id],
      );
    }

    return {
      quote_id: input.quote_id,
      promotion_applied: { id: best.id, kind: best.kind, description: best.description },
      subtotal,
      discount: best.monetaryDiscount,
      total,
    };
  });
}
