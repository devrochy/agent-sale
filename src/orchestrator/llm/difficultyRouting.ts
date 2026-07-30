import type { ModelOption } from "./catalog.js";

export type Dificultad = "economico" | "equilibrado" | "maximo";

/**
 * Señales baratas para clasificar dificultad — sin llamada extra a un
 * LLM clasificador, eso anularía el ahorro de costo que "económico" busca
 * (ver ADR-023). `latestCustomerText` es el texto acumulado de los
 * mensajes de cliente desde el último turno del agente (relevante bajo
 * debounce, ver ADR-022, donde puede haber más de un mensaje en el
 * mismo turno).
 */
export interface DifficultySignal {
  latestCustomerText: string;
  turnosSinResolver: number;
}

// Señales de dificultad real: comparación entre productos o preguntas de
// compatibilidad técnica que el LLM suele necesitar más razonamiento para
// resolver bien (ver toolDefinitions.ts, no hay una tool dedicada a
// comparar — el LLM tiene que combinar varias consultas).
const DIFFICULTY_KEYWORDS = [
  "compatible",
  "compatibilidad",
  " vs ",
  "diferencia entre",
  "cuál es mejor",
  "cual es mejor",
  "técnic",
  "tecnic",
];

const TRIVIAL_MAX_LENGTH = 40;

/**
 * Heurística asimétrica (ver ADR-023): default a "equilibrado"; solo sube
 * a "máximo" ante señales de dificultad reales; reserva "económico" para
 * mensajes claramente triviales. Clasificar mal "fácil" como "equilibrado"
 * cuesta centavos; clasificar mal "difícil" como "económico" es la
 * regresión de calidad que esta feature debería evitar — se prefiere
 * errar caro, no barato, ante señal ambigua.
 */
export function classifyDifficulty(signal: DifficultySignal): Dificultad {
  const text = signal.latestCustomerText.toLowerCase();
  const hasDifficultySignal =
    signal.turnosSinResolver > 0 || DIFFICULTY_KEYWORDS.some((keyword) => text.includes(keyword));
  if (hasDifficultySignal) {
    return "maximo";
  }

  const isTrivial = text.length > 0 && text.length <= TRIVIAL_MAX_LENGTH;
  return isTrivial ? "economico" : "equilibrado";
}

/**
 * Elige un modelo del catálogo del proveedor por índice (0=económico,
 * medio=equilibrado, último=máximo) — los arrays de `PROVIDER_CATALOG`
 * (catalog.ts) ya están ordenados así para los 4 proveedores existentes.
 * Fallback explícito para catálogos con menos de 3 modelos: con 1 modelo
 * es un no-op (siempre ese); con 2, "equilibrado" y "máximo" colapsan al
 * índice 1 (no hay un tercer nivel real que elegir).
 */
export function pickModelByDifficulty(models: ModelOption[], dificultad: Dificultad): string {
  if (models.length === 0) {
    throw new Error("El catálogo no tiene ningún modelo para elegir.");
  }
  if (models.length === 1) {
    return models[0]!.id;
  }
  if (models.length === 2) {
    return dificultad === "economico" ? models[0]!.id : models[1]!.id;
  }
  if (dificultad === "economico") {
    return models[0]!.id;
  }
  if (dificultad === "maximo") {
    return models[models.length - 1]!.id;
  }
  return models[Math.floor((models.length - 1) / 2)]!.id;
}
