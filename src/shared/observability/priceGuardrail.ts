// Guardrail de verificación de precios (ver
// docs/fase-8-observabilidad-seguridad/guardrails.md, "Guardrail 1").
// El diseño ya existente ("el LLM propone, la tool decide") evita que
// Claude calcule un precio, pero no evita que transcriba mal un número al
// redactar el texto final. Esta capa compara los montos que aparecen en
// la respuesta contra los que realmente devolvieron las tools del turno.

const MONEY_KEYS = new Set(["price", "unit_price", "line_total", "subtotal", "total", "discount"]);
const STOCK_KEYS = new Set(["stock"]);

// Tolerancia por redondeo flotante (ver aplicarPromocion.ts, round2()).
const EPSILON = 0.01;

/** Recorre recursivamente un JSON de salida de tool y recolecta los `number` bajo alguna de `keys`. */
function walkForKeys(node: unknown, keys: Set<string>, values: number[], key?: string): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      walkForKeys(item, keys, values);
    }
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [childKey, childValue] of Object.entries(node)) {
      walkForKeys(childValue, keys, values, childKey);
    }
    return;
  }
  if (typeof node === "number" && key !== undefined && keys.has(key)) {
    values.push(node);
  }
}

/**
 * Recolecta los `number` bajo claves de dinero conocidas (vocabulario real
 * usado en consultarInventario/generarCotizacion/aplicarPromocion/
 * crearPedido). Deliberadamente no incluye `stock`/`quantity` — no son
 * montos (ver `extractStockValues`, más abajo).
 */
export function extractMonetaryValues(output: unknown): number[] {
  const values: number[] = [];
  walkForKeys(output, MONEY_KEYS, values);
  return values;
}

/**
 * Recolecta los `number` bajo la clave `stock` (vocabulario real de
 * `consultarInventario.ts`) — misma técnica que `extractMonetaryValues`,
 * para el guardrail de stock (ver `verifyStockGuardrail`, Fase 12.1,
 * "Blindaje anti-invento" extendido a disponibilidad, no solo precio).
 */
export function extractStockValues(output: unknown): number[] {
  const values: number[] = [];
  walkForKeys(output, STOCK_KEYS, values);
  return values;
}

/**
 * Extrae montos en pesos colombianos de texto libre (formato `$X.XXX` o
 * `$X.XXX,XX` — `.` como separador de miles, `,` como decimal). Solo
 * detecta montos con prefijo `$`, a propósito: evita falsos positivos con
 * cantidades, SKUs u otros números que no se presentan como dinero.
 */
export function extractCurrencyAmountsFromText(text: string): number[] {
  const matches = text.match(/\$\s?\d{1,3}(?:\.\d{3})*(?:,\d+)?/g) ?? [];
  return matches.map((match) => {
    const normalized = match
      .replace("$", "")
      .trim()
      .replace(/\./g, "")
      .replace(",", ".");
    return Number(normalized);
  });
}

export interface PriceGuardrailResult {
  ok: boolean;
  mismatched: number[];
}

/**
 * Compara los montos del texto de respuesta contra los montos reales
 * devueltos por las tools ejecutadas en el turno (ver loop.ts,
 * `toolAmountsThisTurn`). Cualquier monto del texto que no coincida
 * (dentro de la tolerancia de redondeo) con ningún monto conocido se
 * reporta como mismatch.
 */
export function verifyPriceGuardrail(
  responseText: string,
  knownAmounts: number[],
): PriceGuardrailResult {
  const textAmounts = extractCurrencyAmountsFromText(responseText);
  const mismatched = textAmounts.filter(
    (amount) => !knownAmounts.some((known) => Math.abs(known - amount) < EPSILON),
  );
  return { ok: mismatched.length === 0, mismatched };
}

/**
 * Extrae afirmaciones de stock del texto de respuesta — solo el patrón
 * "Quedan N" (con o sin "unidad(es)" después), que es el formato exacto
 * que systemPrompt.ts le exige al agente para poder verificarlo (mismo
 * criterio que el prefijo "$" para montos: un patrón acotado a propósito,
 * para no marcar como "afirmación de stock" cualquier número suelto del
 * texto — cantidades que pidió el cliente, SKUs, etc.).
 */
export function extractStockClaimsFromText(text: string): number[] {
  const matches = text.match(/quedan\s+(\d+)/gi) ?? [];
  return matches.map((match) => Number(match.match(/\d+/)![0]));
}

export interface StockGuardrailResult {
  ok: boolean;
  mismatched: number[];
}

/**
 * Extensión de "Guardrail 1" a disponibilidad (ver
 * docs/fase-12-capacidades-proactivas-agente/analisis-superpoderes.md,
 * superpoder #1): misma técnica que `verifyPriceGuardrail`, pero para
 * cantidades de stock — sin tolerancia de redondeo, son enteros exactos
 * devueltos por `consultar_inventario`.
 */
export function verifyStockGuardrail(
  responseText: string,
  knownStock: number[],
): StockGuardrailResult {
  const claimed = extractStockClaimsFromText(responseText);
  const mismatched = claimed.filter((amount) => !knownStock.includes(amount));
  return { ok: mismatched.length === 0, mismatched };
}
