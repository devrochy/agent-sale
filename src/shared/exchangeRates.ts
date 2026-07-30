import { logger } from "./observability/logger.js";

export const SUPPORTED_CURRENCIES = ["USD", "COP", "MXN", "ARS", "CLP", "PEN", "BRL"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export function isCurrency(value: string): value is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export interface CurrencyMeta {
  symbol: string;
  decimals: number;
}

// COP/CLP no usan centavos en el uso cotidiano (igual que formatCOP en
// adminPanel.ts, ya establecido para precios de productos); el resto sí.
export const CURRENCY_META: Record<Currency, CurrencyMeta> = {
  USD: { symbol: "$", decimals: 2 },
  COP: { symbol: "$", decimals: 0 },
  MXN: { symbol: "$", decimals: 2 },
  ARS: { symbol: "$", decimals: 2 },
  CLP: { symbol: "$", decimals: 0 },
  PEN: { symbol: "S/", decimals: 2 },
  BRL: { symbol: "R$", decimals: 2 },
};

interface RatesCache {
  rates: Record<string, number>;
  fetchedAt: number;
}

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
let cache: RatesCache | null = null;

/**
 * open.er-api.com: sin API key, actualiza diario — suficiente para mostrar
 * costos convertidos en el panel (no es un caso de uso financiero que
 * necesite tasas al segundo). Caché en memoria del proceso; si el fetch
 * falla, devuelve el último valor conocido (o null si nunca hubo uno) en
 * vez de romper la página de Analítica.
 */
export async function getUsdExchangeRates(): Promise<Record<string, number> | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.rates;
  }
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/USD");
    if (!response.ok) {
      throw new Error(`Respuesta ${response.status}`);
    }
    const data = (await response.json()) as { result?: string; rates?: Record<string, number> };
    if (data.result !== "success" || !data.rates) {
      throw new Error(`Respuesta sin result=success: ${JSON.stringify(data).slice(0, 200)}`);
    }
    cache = { rates: data.rates, fetchedAt: Date.now() };
    return cache.rates;
  } catch (error) {
    logger.warn(
      { error, event: "exchangeRates.fetch_fallido" },
      "No se pudo obtener tasas de cambio en vivo",
    );
    return cache?.rates ?? null;
  }
}

export function convertFromUsd(
  amountUsd: number,
  currency: Currency,
  rates: Record<string, number> | null,
): number | null {
  if (currency === "USD") {
    return amountUsd;
  }
  const rate = rates?.[currency];
  if (!rate) {
    return null;
  }
  return amountUsd * rate;
}

export function formatMoney(amount: number, currency: Currency): string {
  const meta = CURRENCY_META[currency];
  // Mismo criterio que el fix previo de formatUSD: un monto real menor a 1
  // unidad de la moneda no debe mostrarse como si fuera cero.
  const decimals = amount > 0 && amount < 1 ? Math.max(meta.decimals, 4) : meta.decimals;
  // USD: notación con punto (estilo reporte interno, igual que formatUSD).
  // Otras monedas: separador es-CO (coma decimal, punto de miles), igual
  // que formatCOP ya usa para precios de productos — más el código ISO
  // porque varias de estas monedas comparten el símbolo "$" y sin el
  // código quedaría ambiguo cuál es cuál.
  if (currency === "USD") {
    return `${meta.symbol}${amount.toFixed(decimals)}`;
  }
  const formatted = amount.toLocaleString("es-CO", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${meta.symbol}${formatted} ${currency}`;
}
