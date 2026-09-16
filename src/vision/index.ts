import { env } from "../config/env.js";
import { getOcrConfig } from "../shared/db/settingsDirectory.js";
import { callVisionModel, type VisionProviderConfig } from "./callVisionModel.js";
import { isVisionProviderKey, VISION_PROVIDER_CATALOG, type VisionProviderKey } from "./catalog.js";

// A diferencia de ResolvedLlmProvider (que trae la instancia ya construida
// del LLMProvider concreto, y por eso puede darse el lujo de un
// `providerKey: ProviderKey | "env-default"` puramente informativo), acá
// `providerKey` viaja hasta `callVisionModel` para el despacho — siempre
// tiene que ser una clave real del catálogo. El caso "sin config
// guardada" resuelve directo a "anthropic" (el default de plataforma es
// siempre Claude vision), no hay una tercera clave "env-default" que
// declarar.
export type ResolvedVisionProvider = VisionProviderConfig;

/**
 * Comportamiento hardcodeado de antes de esta feature: Claude Sonnet 5
 * vision con `env.anthropicApiKey`. Se instancia por llamada, no
 * singleton — mismo criterio que `buildPlatformDefaultProvider` en
 * `orchestrator/llm/index.ts`.
 */
function buildPlatformDefaultVisionProvider(): ResolvedVisionProvider {
  return { providerKey: "anthropic", apiKey: env.anthropicApiKey, model: "claude-sonnet-5" };
}

/**
 * Key de sistema disponible para un proveedor de OCR — solo existe para
 * `anthropic`, porque es el único que además es el default de plataforma
 * (`env.anthropicApiKey`). Deliberadamente sin acoplarse a
 * `env.llmProvider`/al catálogo del LLM conversacional: qué proveedor de
 * chat esté activo no dice nada sobre si hay una key de OCR disponible —
 * son capacidades independientes. `deepseek`/`gemini` siempre exigen BYOK
 * acá, aunque el tenant ya tenga una key de DeepSeek para el LLM.
 */
function systemVisionApiKeyFor(providerKey: VisionProviderKey): string | null {
  return providerKey === "anthropic" && env.anthropicApiKey ? env.anthropicApiKey : null;
}

/**
 * Resuelve qué proveedor/modelo de OCR usar para este mensaje (mismo
 * contrato que `resolveLlmProvider` en `orchestrator/llm/index.ts`). Sin
 * config guardada (`ocr_provider` NULL, el caso normal), el comportamiento
 * es idéntico al hardcode de antes de esta feature — cero regresión.
 */
export async function resolveVisionProvider(): Promise<ResolvedVisionProvider> {
  const config = await getOcrConfig();

  if (!config.provider || !isVisionProviderKey(config.provider)) {
    return buildPlatformDefaultVisionProvider();
  }

  const providerKey = config.provider;
  const entry = VISION_PROVIDER_CATALOG[providerKey];
  const model = config.model ?? entry.defaultModel;
  const apiKey = config.apiKey ?? systemVisionApiKeyFor(providerKey);

  if (!apiKey) {
    throw new Error(
      `Se eligió el proveedor de OCR "${entry.label}" pero no hay una API key propia guardada ni una key de sistema configurada para ese proveedor.`,
    );
  }

  return { providerKey, apiKey, model };
}

export interface VisionConfigCandidate {
  provider: VisionProviderKey;
  model: string;
  /** `null` = usar la key de sistema de ese proveedor si existe (ver systemVisionApiKeyFor). */
  apiKey: string | null;
}

// Imagen 1x1 blanca en base64 (PNG) — fija a propósito: la prueba de
// conexión no necesita una foto real, solo confirmar que la combinación
// proveedor+modelo+key acepta una llamada de visión real sin lanzar.
const PRUEBA_IMAGEN_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/**
 * Prueba una combinación proveedor+modelo+key ANTES de guardarla (botón
 * "Probar y guardar" del panel) — mismo criterio que `testLlmConfig`. No
 * persiste nada, eso lo hace el caller vía `saveOcrConfig` solo si esto no
 * lanza.
 */
export async function testVisionConfig(candidate: VisionConfigCandidate): Promise<void> {
  const entry = VISION_PROVIDER_CATALOG[candidate.provider];
  const apiKey = candidate.apiKey ?? systemVisionApiKeyFor(candidate.provider);
  if (!apiKey) {
    throw new Error(`El proveedor "${entry.label}" no tiene una API key propia ni una key de sistema configurada.`);
  }

  await callVisionModel(
    { providerKey: candidate.provider, apiKey, model: candidate.model },
    Buffer.from(PRUEBA_IMAGEN_BASE64, "base64"),
    "image/png",
    "Respondé únicamente con la palabra: ok",
    16,
  );
}

export { VISION_PROVIDER_CATALOG, isVisionProviderKey, type VisionProviderKey } from "./catalog.js";
export type { VisionProviderConfig } from "./callVisionModel.js";
