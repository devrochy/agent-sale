import { withTransaction } from "./withTransaction.js";

/**
 * CRUD de promociones para el panel admin (Fase 23, ver
 * docs/fase-23-crud-promociones-clasificacion-cliente/adrs/ADR-035-crud-promociones-panel-y-puntos-de-entrada.md).
 * El motor de elegibilidad (`aplicarPromocion.ts`, Fase 17) sigue siendo el
 * único lector de `rules`/las columnas de elegibilidad en tiempo de venta —
 * este módulo solo administra las filas.
 *
 * `type = 'volumen'` (Fase 6) usa una forma de `rules` distinta (tramos con
 * `tiers`, cada uno % o SKU de regalo — ver `VolumeRules` en
 * `aplicarPromocion.ts`) que no encaja en el formulario `label`/`discount_pct`
 * que pide ADR-035 para temporada/campaña. Esta fase no agrega UI para
 * tramos (el DoD pide las 4 dimensiones de elegibilidad, no las 3 formas de
 * `rules`) — las promociones de volumen se siguen viendo en la lista
 * (`listPromotions`) y pueden activarse/desactivarse, pero `createPromotion`/
 * `updatePromotion` no las tocan; se siguen gestionando directo en la base
 * como hoy, igual que el seed de `aplicarPromocion.test.ts`.
 */
export interface PromotionRecord {
  id: string;
  type: "temporada" | "volumen" | "campaña";
  label: string | null;
  discountPct: number | null;
  oncePerCustomer: boolean;
  validFrom: string | null;
  validTo: string | null;
  active: boolean;
  allyId: string | null;
  allyName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  includeChildCategories: boolean;
  productId: string | null;
  productName: string | null;
  variantId: string | null;
  variantSku: string | null;
  eligibleSegments: string[];
}

interface PromotionRow {
  id: string;
  type: "temporada" | "volumen" | "campaña";
  rules: { label?: string; discount_pct?: number; once_per_customer?: boolean };
  valid_from: string | null;
  valid_to: string | null;
  active: boolean;
  ally_id: string | null;
  ally_name: string | null;
  category_id: string | null;
  category_name: string | null;
  include_child_categories: boolean;
  product_id: string | null;
  product_name: string | null;
  variant_id: string | null;
  variant_sku: string | null;
  eligible_segments: string[] | null;
}

function mapPromotionRow(row: PromotionRow): PromotionRecord {
  return {
    id: row.id,
    type: row.type,
    label: row.rules?.label ?? null,
    discountPct: row.rules?.discount_pct ?? null,
    oncePerCustomer: row.rules?.once_per_customer ?? false,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    active: row.active,
    allyId: row.ally_id,
    allyName: row.ally_name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    includeChildCategories: row.include_child_categories,
    productId: row.product_id,
    productName: row.product_name,
    variantId: row.variant_id,
    variantSku: row.variant_sku,
    eligibleSegments: row.eligible_segments ?? [],
  };
}

export async function listPromotions(): Promise<PromotionRecord[]> {
  return withTransaction(async (client) => {
    const result = await client.query<PromotionRow>(
      `SELECT p.id, p.type, p.rules, p.valid_from::text AS valid_from, p.valid_to::text AS valid_to, p.active,
              p.ally_id, a.name AS ally_name,
              p.category_id, pc.name AS category_name, p.include_child_categories,
              p.product_id, pr.name AS product_name,
              p.variant_id, pv.sku AS variant_sku,
              p.eligible_segments
       FROM promotions p
       LEFT JOIN allies a ON a.id = p.ally_id
       LEFT JOIN product_categories pc ON pc.id = p.category_id
       LEFT JOIN products pr ON pr.id = p.product_id
       LEFT JOIN product_variants pv ON pv.id = p.variant_id
       ORDER BY p.type, p.rules ->> 'label'`,
    );
    return result.rows.map(mapPromotionRow);
  });
}

export interface PromotionInput {
  type: "temporada" | "campaña";
  label: string;
  discountPct: number;
  oncePerCustomer: boolean;
  validFrom: string | null;
  validTo: string | null;
  allyId: string | null;
  categoryId: string | null;
  includeChildCategories: boolean;
  productId: string | null;
  variantId: string | null;
  eligibleSegments: string[];
}

function buildRules(input: PromotionInput): Record<string, unknown> {
  if (input.type === "campaña") {
    return { kind: "campaña", label: input.label, discount_pct: input.discountPct, once_per_customer: input.oncePerCustomer };
  }
  return { kind: "temporada", label: input.label, discount_pct: input.discountPct };
}

export async function createPromotion(input: PromotionInput): Promise<string> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO promotions
         (type, rules, valid_from, valid_to, ally_id, category_id, include_child_categories, product_id, variant_id, eligible_segments)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        input.type,
        JSON.stringify(buildRules(input)),
        input.validFrom,
        input.validTo,
        input.allyId,
        input.categoryId,
        input.includeChildCategories,
        input.productId,
        input.variantId,
        input.eligibleSegments.length > 0 ? input.eligibleSegments : null,
      ],
    );
    return result.rows[0]!.id;
  });
}

export async function updatePromotion(promotionId: string, input: PromotionInput): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE promotions SET
         type = $1, rules = $2, valid_from = $3, valid_to = $4,
         ally_id = $5, category_id = $6, include_child_categories = $7,
         product_id = $8, variant_id = $9, eligible_segments = $10
       WHERE id = $11`,
      [
        input.type,
        JSON.stringify(buildRules(input)),
        input.validFrom,
        input.validTo,
        input.allyId,
        input.categoryId,
        input.includeChildCategories,
        input.productId,
        input.variantId,
        input.eligibleSegments.length > 0 ? input.eligibleSegments : null,
        promotionId,
      ],
    );
  });
}

export async function setPromotionActive(promotionId: string, active: boolean): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`UPDATE promotions SET active = $1 WHERE id = $2`, [active, promotionId]);
  });
}
