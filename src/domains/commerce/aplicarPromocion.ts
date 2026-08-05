import type { PoolClient } from "pg";
import { withTransaction } from "../../shared/db/index.js";

export interface AplicarPromocionInput {
  quote_id: string;
  // Aceptado por compatibilidad con el contrato funcional de la Fase 1,
  // pero sin efecto: docs/fase-6-dominio-comercial/motor-promociones.md no
  // define un sistema de códigos (promotions no tiene columna `code`) —
  // la evaluación es siempre automática (temporada + volumen + campaña).
  promo_code?: string | null;
}

export interface AplicarPromocionOutput {
  quote_id: string;
  promotion_applied: { id: string; kind: "temporada" | "volumen" | "campaña"; description: string } | null;
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

interface CampaignRules {
  kind: "campaña";
  label: string;
  discount_pct: number;
  once_per_customer: boolean;
}

interface PromotionRow {
  id: string;
  type: "temporada" | "volumen" | "campaña";
  rules: VolumeRules | SeasonRules | CampaignRules;
  ally_id: string | null;
  category_id: string | null;
  include_child_categories: boolean;
  product_id: string | null;
  variant_id: string | null;
  eligible_segments: string[] | null;
}

interface BestPromotion {
  id: string;
  kind: "temporada" | "volumen" | "campaña";
  description: string;
  benefitValue: number;
  monetaryDiscount: number;
  freeItemSku?: string;
}

interface QuoteLineItem {
  variant_id: string;
  product_id: string;
  ally_id: string | null;
  category_id: string | null;
  quantity: number;
}

export type CustomerSegment = "nuevo" | "ocasional" | "frecuente" | "fiel" | "inactivo";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

interface ClassificationThresholds {
  customer_frecuente_min_pedidos: number;
  customer_frecuente_intervalo_max_dias: number;
  customer_inactivo_dias_sin_comprar: number;
  customer_fiel_min_pedidos: number;
}

const MS_POR_DIA = 1000 * 60 * 60 * 24;

/**
 * Clasifica al cliente en 5 niveles (ver ADR-036, Fase 23): conteo de
 * pedidos reales (no expirados, un `expirado` nunca se vendió de verdad —
 * Fase 15/16) + periodicidad (intervalo promedio entre pedidos, distingue
 * "frecuente" de "ocasional") + recencia del último pedido, evaluada
 * siempre al final como override de "inactivo" — un cliente `fiel` u
 * `ocasional` que deja de comprar por mucho tiempo es el mismo riesgo de
 * fuga que un `frecuente` que deja de volver, por eso el override no se
 * restringe solo a esos dos segmentos.
 */
export async function clasificarCliente(client: PoolClient, customerId: string | null): Promise<CustomerSegment> {
  if (!customerId) {
    return "nuevo";
  }
  const [ordersResult, thresholdsResult] = await Promise.all([
    client.query<{ created_at: Date }>(
      `SELECT created_at FROM orders WHERE customer_id = $1 AND status != 'expirado' ORDER BY created_at`,
      [customerId],
    ),
    client.query<ClassificationThresholds>(
      `SELECT customer_frecuente_min_pedidos, customer_frecuente_intervalo_max_dias,
              customer_inactivo_dias_sin_comprar, customer_fiel_min_pedidos
       FROM settings`,
    ),
  ]);
  const orderDates = ordersResult.rows.map((r) => new Date(r.created_at));
  const count = orderDates.length;
  if (count === 0) {
    return "nuevo";
  }
  const thresholds = thresholdsResult.rows[0]!;

  let segment: CustomerSegment;
  if (count === 1) {
    segment = "nuevo";
  } else if (count >= thresholds.customer_fiel_min_pedidos) {
    segment = "fiel";
  } else if (count >= thresholds.customer_frecuente_min_pedidos) {
    const gaps: number[] = [];
    for (let i = 1; i < orderDates.length; i++) {
      gaps.push((orderDates[i]!.getTime() - orderDates[i - 1]!.getTime()) / MS_POR_DIA);
    }
    const intervaloPromedioDias = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    segment = intervaloPromedioDias <= thresholds.customer_frecuente_intervalo_max_dias ? "frecuente" : "ocasional";
  } else {
    segment = "ocasional";
  }

  const diasDesdeUltimoPedido = (Date.now() - orderDates[count - 1]!.getTime()) / MS_POR_DIA;
  if (diasDesdeUltimoPedido > thresholds.customer_inactivo_dias_sin_comprar) {
    return "inactivo";
  }
  return segment;
}

/**
 * Devuelve el conjunto de ids de categoría elegibles para un candidato con
 * `category_id` seteado: la propia categoría, más sus descendientes si
 * `include_child_categories` (default true). Único uso de `WITH RECURSIVE`
 * en el repo — recorre `product_categories.parent_id` (árbol de Fase 14).
 */
async function categoriaConDescendientes(
  client: PoolClient,
  categoryId: string,
  includeChildren: boolean,
): Promise<Set<string>> {
  if (!includeChildren) {
    return new Set([categoryId]);
  }
  const result = await client.query<{ id: string }>(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM product_categories WHERE id = $1
       UNION ALL
       SELECT pc.id FROM product_categories pc JOIN descendants d ON pc.parent_id = d.id
     )
     SELECT id FROM descendants`,
    [categoryId],
  );
  return new Set(result.rows.map((r) => r.id));
}

/**
 * Determina si TODAS las líneas de la cotización cumplen cada dimensión de
 * elegibilidad que el candidato tenga seteada (decisión de diseño Fase 17:
 * si una sola línea no cumple, la promoción completa queda descartada — no
 * hay descuento parcial por línea, preserva el "un solo beneficio sobre el
 * total" ya aceptado en Fase 6).
 */
async function esElegible(
  client: PoolClient,
  promo: PromotionRow,
  items: QuoteLineItem[],
  segment: CustomerSegment,
  customerId: string | null,
): Promise<boolean> {
  if (promo.ally_id && !items.every((i) => i.ally_id === promo.ally_id)) {
    return false;
  }
  if (promo.product_id && !items.every((i) => i.product_id === promo.product_id)) {
    return false;
  }
  if (promo.variant_id && !items.every((i) => i.variant_id === promo.variant_id)) {
    return false;
  }
  if (promo.category_id) {
    const eligibleCategoryIds = await categoriaConDescendientes(
      client,
      promo.category_id,
      promo.include_child_categories,
    );
    if (!items.every((i) => i.category_id !== null && eligibleCategoryIds.has(i.category_id))) {
      return false;
    }
  }
  if (promo.eligible_segments && promo.eligible_segments.length > 0 && !promo.eligible_segments.includes(segment)) {
    return false;
  }
  if (promo.type === "campaña") {
    const rules = promo.rules as CampaignRules;
    if (rules.once_per_customer) {
      if (!customerId) {
        return false;
      }
      const redeemed = await client.query(
        `SELECT id FROM promotion_redemptions WHERE promotion_id = $1 AND customer_id = $2`,
        [promo.id, customerId],
      );
      if (redeemed.rows.length > 0) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Tool aplicar_promocion (ver docs/fase-6-dominio-comercial/motor-promociones.md
 * y docs/fase-17-motor-promociones-avanzado/adrs/ADR-027-elegibilidad-multidimension-y-clasificacion-cliente.md).
 * La tool evalúa, nunca el LLM: filtra candidatos por elegibilidad
 * (aliado/categoría/producto/variante/segmento/campaña ya redimida),
 * calcula el beneficio real de cada promoción elegible y aplica la de
 * mayor beneficio para el cliente — nunca se combinan/apilan promociones.
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
    const quoteResult = await client.query<{ id: string; subtotal: string; customer_id: string | null }>(
      `SELECT id, subtotal, customer_id FROM quotes WHERE id = $1`,
      [input.quote_id],
    );
    const quote = quoteResult.rows[0];
    if (!quote) {
      throw new Error(`Cotización no encontrada: ${input.quote_id}`);
    }
    const subtotal = Number(quote.subtotal);

    const itemsResult = await client.query<QuoteLineItem & { quantity: string }>(
      `SELECT qi.variant_id, pv.product_id, p.ally_id, p.category_id, qi.quantity
       FROM quote_items qi
       JOIN product_variants pv ON pv.id = qi.variant_id
       JOIN products p ON p.id = pv.product_id
       WHERE qi.quote_id = $1`,
      [input.quote_id],
    );
    const items: QuoteLineItem[] = itemsResult.rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));
    const totalQuantity = items.reduce((sum, i) => sum + i.quantity, 0);

    const segment = await clasificarCliente(client, quote.customer_id);

    const promotionsResult = await client.query<PromotionRow>(
      `SELECT id, type, rules, ally_id, category_id, include_child_categories, product_id, variant_id, eligible_segments
       FROM promotions
       WHERE active = true
         AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
         AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)`,
    );

    let best: BestPromotion | null = null;

    for (const promo of promotionsResult.rows) {
      if (!(await esElegible(client, promo, items, segment, quote.customer_id))) {
        continue;
      }

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
      } else if (promo.type === "temporada") {
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
      } else {
        const rules = promo.rules as CampaignRules;
        const amount = round2((subtotal * rules.discount_pct) / 100);
        if (!best || amount > best.benefitValue) {
          best = {
            id: promo.id,
            kind: "campaña",
            description: `${rules.label} (${rules.discount_pct}% de descuento)`,
            benefitValue: amount,
            monetaryDiscount: amount,
          };
        }
      }
    }

    if (!best) {
      await client.query(`UPDATE quotes SET applied_promotion_id = NULL WHERE id = $1`, [input.quote_id]);
      return {
        quote_id: input.quote_id,
        promotion_applied: null,
        subtotal,
        discount: 0,
        total: subtotal,
      };
    }

    const total = round2(subtotal - best.monetaryDiscount);

    await client.query(`UPDATE quotes SET discount = $1, total = $2, applied_promotion_id = $3 WHERE id = $4`, [
      best.monetaryDiscount,
      total,
      best.id,
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
