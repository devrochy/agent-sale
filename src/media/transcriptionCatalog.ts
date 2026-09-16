/**
 * Catálogo de proveedores de transcripción de audio, configurable por
 * panel igual que el catálogo de visión (`vision/catalog.ts`) y el de LLM
 * conversacional (`orchestrator/llm/catalog.ts`, ADR-020). Sin `family`
 * a propósito: a diferencia de visión (3 shapes de API distintos), los
 * dos proveedores acá hablan el mismo formato multipart de la API de
 * Whisper de OpenAI — Groq lo expone byte a byte igual
 * (`https://api.groq.com/openai/v1/audio/transcriptions`), solo cambia
 * `baseUrl`/modelo/key. Por eso no hace falta un despachador por
 * proveedor como `callVisionModel` — `transcribirAudio.ts` sirve a los
 * dos tal cual.
 */
export type TranscriptionProviderKey = "openai" | "groq";

export interface TranscriptionModelOption {
  id: string;
  label: string;
}

export interface TranscriptionCatalogEntry {
  label: string;
  baseUrl: string;
  defaultModel: string;
  models: TranscriptionModelOption[];
  /** Prefijo típico de la API key de este proveedor, solo para el placeholder del campo BYOK en el panel. */
  keyPlaceholder: string;
}

export const TRANSCRIPTION_PROVIDER_CATALOG: Record<TranscriptionProviderKey, TranscriptionCatalogEntry> = {
  openai: {
    label: "OpenAI (Whisper)",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "whisper-1",
    models: [{ id: "whisper-1", label: "Whisper-1" }],
    keyPlaceholder: "sk-…",
  },
  groq: {
    label: "Groq (Whisper hospedado)",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "whisper-large-v3-turbo",
    models: [
      { id: "whisper-large-v3-turbo", label: "Whisper Large v3 Turbo · el más rápido y barato" },
      { id: "whisper-large-v3", label: "Whisper Large v3 · más preciso" },
    ],
    keyPlaceholder: "gsk_…",
  },
};

export function isTranscriptionProviderKey(value: string): value is TranscriptionProviderKey {
  return Object.prototype.hasOwnProperty.call(TRANSCRIPTION_PROVIDER_CATALOG, value);
}
