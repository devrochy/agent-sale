import { env } from "../config/env.js";
import { getOpenAiConfig, getTranscriptionConfig } from "../shared/db/settingsDirectory.js";
import {
  isTranscriptionProviderKey,
  TRANSCRIPTION_PROVIDER_CATALOG,
  type TranscriptionProviderKey,
} from "./transcriptionCatalog.js";
import { transcribirAudio, type TranscriptionProviderConfig } from "./transcribirAudio.js";

export interface ResolvedTranscriptionProvider extends TranscriptionProviderConfig {
  providerKey: TranscriptionProviderKey | "env-default";
}

/**
 * Puente con la key legada de OpenAI (migración 0061, ver
 * settingsDirectory.ts → getOpenAiConfig): antes de esta feature, esa key
 * BYOK era la ÚNICA config de transcripción posible, sin proveedor ni
 * modelo elegibles. Si `transcription_provider` está vacío (el panel
 * nuevo nunca se tocó) pero esa key sí tiene un valor, se trata como si
 * ya hubiera "openai" guardado explícito — nunca se migra el dato en la
 * base (no hay UPDATE acá), es puramente una lectura que sintetiza el
 * resultado. Solo si TAMPOCO hay key legada es "Automático" de verdad
 * (cae a `env.openaiApiKey`, el comportamiento de siempre).
 */
async function resolveLegacyOpenAiBridge(): Promise<ResolvedTranscriptionProvider> {
  const { apiKey } = await getOpenAiConfig();
  const entry = TRANSCRIPTION_PROVIDER_CATALOG.openai;
  return {
    providerKey: apiKey ? "openai" : "env-default",
    apiKey: apiKey || env.openaiApiKey,
    baseUrl: entry.baseUrl,
    model: entry.defaultModel,
  };
}

/**
 * Key de sistema disponible para un proveedor de transcripción — solo
 * existe para "openai", porque es el único que ya se podía configurar
 * antes de esta feature (`env.openaiApiKey`). "groq" siempre exige BYOK.
 */
function systemTranscriptionApiKeyFor(providerKey: TranscriptionProviderKey): string | null {
  return providerKey === "openai" && env.openaiApiKey ? env.openaiApiKey : null;
}

/**
 * Resuelve qué proveedor/modelo de transcripción usar para este mensaje
 * (mismo contrato que `resolveVisionProvider`/`resolveLlmProvider`). Sin
 * config guardada en las columnas nuevas, cae al puente con la key legada
 * — cero regresión para instalaciones que ya configuraron Whisper por
 * panel antes de esta feature.
 */
export async function resolveTranscriptionProvider(): Promise<ResolvedTranscriptionProvider> {
  const config = await getTranscriptionConfig();

  if (!config.provider || !isTranscriptionProviderKey(config.provider)) {
    return resolveLegacyOpenAiBridge();
  }

  const providerKey = config.provider;
  const entry = TRANSCRIPTION_PROVIDER_CATALOG[providerKey];
  const model = config.model ?? entry.defaultModel;
  const apiKey = config.apiKey ?? systemTranscriptionApiKeyFor(providerKey);

  if (!apiKey) {
    throw new Error(
      `Se eligió el proveedor de transcripción "${entry.label}" pero no hay una API key propia guardada ni una key de sistema configurada para ese proveedor.`,
    );
  }

  return { providerKey, apiKey, baseUrl: entry.baseUrl, model };
}

export interface TranscriptionDisplayState {
  providerKey: TranscriptionProviderKey | null;
  model: string | null;
  apiKey: string | null;
}

/**
 * Estado a mostrar en el panel (Configuración → Transcripción de audio) —
 * mismo puente con la key legada que `resolveTranscriptionProvider`, pero
 * sin caer nunca a `env.openaiApiKey` ni lanzar: el panel necesita
 * distinguir "de verdad no hay nada configurado" (`providerKey: null`,
 * muestra "Automático") de "hay algo guardado, mostralo" — no resolver un
 * proveedor utilizable para transcribir ya mismo.
 */
export async function describeTranscriptionConfig(): Promise<TranscriptionDisplayState> {
  const config = await getTranscriptionConfig();
  if (config.provider && isTranscriptionProviderKey(config.provider)) {
    return { providerKey: config.provider, model: config.model, apiKey: config.apiKey };
  }
  const { apiKey: legacyApiKey } = await getOpenAiConfig();
  if (legacyApiKey) {
    return { providerKey: "openai", model: "whisper-1", apiKey: legacyApiKey };
  }
  return { providerKey: null, model: null, apiKey: null };
}

export interface TranscriptionConfigCandidate {
  provider: TranscriptionProviderKey;
  model: string;
  /** `null` = usar la key de sistema de ese proveedor si existe (ver systemTranscriptionApiKeyFor). */
  apiKey: string | null;
}

// Audio de prueba fijo (1s de silencio, OGG/Opus) — no necesita transcribir
// nada con sentido: un 200 con texto vacío (-> null) confirma igual que la
// key/endpoint funcionan, que es todo lo que "Probar y guardar" necesita.
const PRUEBA_AUDIO_BASE64 =
  "T2dnUwACAAAAAAAAAACYmPdtAAAAAH5jkm0BE09wdXNIZWFkAQE4AYA+AAAAAABPZ2dTAAAAAAAAAAAAAJiY920BAAAAGl2c8gE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAACAuwAAAAAAAJiY920CAAAAyZsFpTIDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA7j//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//rj//k9nZ1MABLi8AAAAAAAAmJj3bQMAAADh7rhzAQO4//4=";

/**
 * Prueba una combinación proveedor+modelo+key ANTES de guardarla (botón
 * "Probar y guardar" del panel) — mismo criterio que
 * `testVisionConfig`/`testLlmConfig`. No persiste nada, eso lo hace el
 * caller vía `saveTranscriptionConfig` solo si esto no lanza.
 */
export async function testTranscriptionConfig(candidate: TranscriptionConfigCandidate): Promise<void> {
  const entry = TRANSCRIPTION_PROVIDER_CATALOG[candidate.provider];
  const apiKey = candidate.apiKey ?? systemTranscriptionApiKeyFor(candidate.provider);
  if (!apiKey) {
    throw new Error(`El proveedor "${entry.label}" no tiene una API key propia ni una key de sistema configurada.`);
  }

  await transcribirAudio(Buffer.from(PRUEBA_AUDIO_BASE64, "base64"), "audio/ogg", {
    apiKey,
    baseUrl: entry.baseUrl,
    model: candidate.model,
  });
}

export {
  isTranscriptionProviderKey,
  TRANSCRIPTION_PROVIDER_CATALOG,
  type TranscriptionProviderKey,
} from "./transcriptionCatalog.js";
export type { TranscriptionProviderConfig } from "./transcribirAudio.js";
