// Guardrail de verificación de precios (ver
// docs/fase-8-observabilidad-seguridad/guardrails.md, "Guardrail 1").
// El diseño ya existente ("el LLM propone, la tool decide") evita que
// Claude calcule un precio, pero no evita que transcriba mal un número al
// redactar el texto final. Esta capa compara los montos que aparecen en
// la respuesta contra los que realmente devolvieron las tools del turno.

const MONEY_KEYS = new Set(["price", "unit_price", "line_total", "subtotal", "total", "discount"]);

// Tolerancia por redondeo flotante (ver aplicarPromocion.ts, round2()).
const EPSILON = 0.01;

/**
 * Recorre recursivamente el JSON de salida de una tool y recolecta los
 * `number` bajo claves de dinero conocidas (vocabulario real usado en
 * consultarInventario/generarCotizacion/aplicarPromocion/crearPedido).
 * Deliberadamente no incluye `stock`/`quantity` — no son montos.
 */
export function extractMonetaryValues(output: unknown): number[] {
  const values: number[] = [];

  function walk(node: unknown, key?: string): void {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [childKey, childValue] of Object.entries(node)) {
        walk(childValue, childKey);
      }
      return;
    }
    if (typeof node === "number" && key !== undefined && MONEY_KEYS.has(key)) {
      values.push(node);
    }
  }

  walk(output);
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
