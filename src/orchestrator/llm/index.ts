import { env } from "../../config/env.js";
import { getLlmConfig } from "../../shared/db/settingsDirectory.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { isProviderKey, PROVIDER_CATALOG, type ProviderKey } from "./catalog.js";
import { classifyDifficulty, pickModelByDifficulty, type DifficultySignal } from "./difficultyRouting.js";
import { GeminiProvider } from "./geminiProvider.js";
import { OpenAICompatibleProvider } from "./openaiCompatibleProvider.js";
import type { LLMProvider } from "./types.js";

export interface ResolvedLlmProvider {
  provider: LLMProvider;
  model: string;
  /** Clave del catálogo (ver catalog.ts), o "env-default" cuando el tenant no configuró nada — Fase 11.5 usa esto para llm_usage.provider. */
  providerKey: ProviderKey | "env-default";
  /** Solo presente cuando el modo de ruteo es "auto_dificultad" (ADR-023) — para loguear qué tier eligió la heurística. */
  dificultad?: "economico" | "equilibrado" | "maximo";
}

/**
 * Mismo proveedor/modelo que se usaba antes de la Fase 11.4 — el default
 * de plataforma vía env (ADR-010). Se instancia por llamada (no
 * singleton) para que exista un único código path sin importar si vino
 * de acá o de la config guardada (ver resolveLlmProvider).
 */
function buildPlatformDefaultProvider(): ResolvedLlmProvider {
  if (env.llmProvider === "openai_compatible") {
    return { provider: new OpenAICompatibleProvider(), model: env.llmModel, providerKey: "env-default" };
  }
  return { provider: new AnthropicProvider(), model: "claude-sonnet-5", providerKey: "env-default" };
}

/**
 * Key de sistema disponible para una entrada del catálogo — solo existe
 * de verdad para el proveedor que ya es el default de plataforma hoy
 * (env.LLM_PROVIDER/ANTHROPIC_API_KEY/LLM_API_KEY). Para cualquier otra
 * entrada (incluyendo Gemini, que nunca es default) no hay key de
 * sistema — el tenant debe traer la suya (BYOK, ver ADR-020).
 */
function systemApiKeyFor(providerKey: ProviderKey): string | null {
  if (providerKey === "anthropic" && env.llmProvider === "anthropic" && env.anthropicApiKey) {
    return env.anthropicApiKey;
  }
  if (providerKey === "deepseek" && env.llmProvider === "openai_compatible" && env.llmApiKey) {
    return env.llmApiKey;
  }
  return null;
}

/**
 * Resuelve qué proveedor/modelo usar en este turno (Fase 11.4, ver
 * docs/fase-11-panel-admin-dashboard/adrs/
 * ADR-020-proveedor-modelo-configurable-byok.md). Sin config guardada
 * (`llm_provider` NULL, el caso normal), el comportamiento es idéntico al
 * de antes de esta fase — cero regresión sin config.
 *
 * `difficultySignal` solo se usa si `routingMode: "auto_dificultad"`
 * ("Cerebro del bot", ver ADR-023) está activo — el caller (loop.ts) lo
 * arma a partir del mensaje del cliente y el estado de la conversación;
 * si se omite, se asume el caso menos exigente (sin señal).
 */
export async function resolveLlmProvider(difficultySignal?: DifficultySignal): Promise<ResolvedLlmProvider> {
  const config = await getLlmConfig();

  if (!config.provider || !isProviderKey(config.provider)) {
    return buildPlatformDefaultProvider();
  }

  const providerKey = config.provider;
  const entry = PROVIDER_CATALOG[providerKey];
  const dificultad =
    config.routingMode === "auto_dificultad"
      ? classifyDifficulty(difficultySignal ?? { latestCustomerText: "", turnosSinResolver: 0 })
      : undefined;
  const model = dificultad ? pickModelByDifficulty(entry.models, dificultad) : (config.model ?? entry.defaultModel);
  const apiKey = config.apiKey ?? systemApiKeyFor(providerKey);

  if (!apiKey) {
    throw new Error(
      `Se eligió el proveedor "${entry.label}" pero no hay una API key propia guardada ni una key de sistema configurada para ese proveedor.`,
    );
  }

  switch (entry.family) {
    case "anthropic":
      return { provider: new AnthropicProvider({ apiKey, model }), model, providerKey, dificultad };
    case "gemini":
      return { provider: new GeminiProvider({ apiKey, model }), model, providerKey, dificultad };
    case "openai_compatible":
      return {
        provider: new OpenAICompatibleProvider({ apiKey, model, baseUrl: entry.baseUrl }),
        model,
        providerKey,
        dificultad,
      };
  }
}

export interface LlmConfigCandidate {
  provider: ProviderKey;
  model: string;
  /** `null` = usar la key de sistema de ese proveedor si existe (ver systemApiKeyFor). */
  apiKey: string | null;
}

/**
 * Prueba una combinación proveedor+modelo+key ANTES de guardarla (botón
 * "Probar y guardar" del panel, ver adminPanel.ts) — arma el mismo
 * `LLMProvider` que armaría resolveLlmProviderForTenant, pero con valores
 * todavía no persistidos en `tenants`. Lanza si la combinación no sirve
 * (key inválida, proveedor sin key de sistema disponible); no persiste
 * nada, eso lo hace el caller vía saveLlmConfig solo si esto no lanza.
 */
export async function testLlmConfig(candidate: LlmConfigCandidate): Promise<void> {
  const entry = PROVIDER_CATALOG[candidate.provider];
  const apiKey = candidate.apiKey ?? systemApiKeyFor(candidate.provider);
  if (!apiKey) {
    throw new Error(
      `El proveedor "${entry.label}" no tiene una API key propia ni una key de sistema configurada.`,
    );
  }

  let provider: LLMProvider;
  switch (entry.family) {
    case "anthropic":
      provider = new AnthropicProvider({ apiKey, model: candidate.model });
      break;
    case "gemini":
      provider = new GeminiProvider({ apiKey, model: candidate.model });
      break;
    case "openai_compatible":
      provider = new OpenAICompatibleProvider({ apiKey, model: candidate.model, baseUrl: entry.baseUrl });
      break;
  }

  await provider.converse({
    systemPrompt: ["Eres una prueba de conexión. Responde únicamente con la palabra: ok"],
    tools: [],
    messages: [{ role: "user", content: "ping" }],
  });
}

export {
  PROVIDER_CATALOG,
  isLlmRoutingMode,
  isProviderKey,
  type LlmRoutingMode,
  type ProviderKey,
} from "./catalog.js";
export type { ContentBlock, LLMMessage, ToolDefinition, TurnResponse } from "./types.js";
export type { LLMProvider } from "./types.js";
