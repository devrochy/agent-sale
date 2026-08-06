/**
 * Tercer bloque de `system` (ver ADR-030, extiende ADR-021): voz de marca
 * + RAG institucional (misión/visión/valores). A diferencia del tono
 * (toneBlocks.ts, 3 variantes fijas), acá es texto libre por negocio — no
 * existe un conjunto razonable de variantes fijas para la identidad de
 * una marca. Esto significa que el breakpoint de `cache_control` de este
 * bloque no se comparte entre negocios distintos como sí pasa con el de
 * tono, pero cada uno sigue cacheando su propio prefijo entre turnos de
 * una misma conversación (ver docs/fase-4-motor-agente/prompt-caching.md).
 *
 * Solo se agrega un tercer elemento al array de `system` cuando hay algo
 * configurado — un negocio sin voz de marca configurada no paga ningún
 * costo extra de tokens ni de escritura de caché por este bloque.
 */
export interface BrandVoiceConfig {
  nombreAsistente: string;
  mision: string;
  vision: string;
  valores: string;
  nomenclatura: string;
}

export const EMPTY_BRAND_VOICE_CONFIG: BrandVoiceConfig = {
  nombreAsistente: "",
  mision: "",
  vision: "",
  valores: "",
  nomenclatura: "",
};

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveBrandVoiceConfig(override: Record<string, unknown> | null): BrandVoiceConfig {
  if (!override) {
    return EMPTY_BRAND_VOICE_CONFIG;
  }
  return {
    nombreAsistente: asString(override.nombreAsistente),
    mision: asString(override.mision),
    vision: asString(override.vision),
    valores: asString(override.valores),
    nomenclatura: asString(override.nomenclatura),
  };
}

/**
 * Devuelve null (no se agrega bloque ni breakpoint) si no hay ningún
 * campo configurado — mismo criterio de "no pagar por lo que no se usa"
 * que el resto de la configuración opcional del tenant.
 */
export function buildBrandVoiceBlock(config: BrandVoiceConfig): string | null {
  const lines: string[] = [];

  if (config.nombreAsistente) {
    lines.push(`Te llamás "${config.nombreAsistente}" — presentate con ese nombre cuando corresponda.`);
  }
  if (config.mision) {
    lines.push(`Misión de la empresa: ${config.mision}`);
  }
  if (config.vision) {
    lines.push(`Visión de la empresa: ${config.vision}`);
  }
  if (config.valores) {
    lines.push(`Valores de la empresa: ${config.valores}`);
  }
  if (config.nomenclatura) {
    lines.push(`Nomenclatura propia del negocio (usá estos términos, no genéricos): ${config.nomenclatura}`);
  }

  if (lines.length === 0) {
    return null;
  }

  return `Identidad de la marca — alineá tus respuestas con esto, sin recitarlo textual ni mencionarlo como si fuera un guion:\n\n${lines.join("\n")}`;
}
