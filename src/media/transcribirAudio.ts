import { env } from "../config/env.js";
import { fetchWithTimeout } from "../shared/http/fetchWithTimeout.js";

/**
 * Transcripción de audio entrante (notas de voz de WhatsApp) — llamada
 * directa sin SDK (mismo criterio que Wompi/Meta, ADR-033: una
 * dependencia no se paga por un solo endpoint) al endpoint de
 * transcripciones estilo Whisper de OpenAI. Sirve por igual a cualquier
 * proveedor que hable ese mismo formato multipart — hoy OpenAI y Groq
 * (ver `transcriptionCatalog.ts`): Groq expone el endpoint byte a byte
 * igual, solo cambia `baseUrl`/modelo/key, así que no hace falta un
 * despachador por proveedor como el de `vision/callVisionModel.ts`.
 *
 * Devuelve `null` (no lanza) cuando el proveedor no pudo sacar nada en
 * limpio (silencio, ruido, audio corrupto) — es un resultado válido, no
 * un error; el caller (`mediaIngestion.ts`) le pide al cliente que lo
 * reenvíe o lo escriba. Si la llamada a la API falla de verdad (red,
 * auth, 5xx), sí lanza — ese caso lo reintenta el consumer de la cola.
 *
 * El proveedor/modelo/key ya viene resuelto por el caller (ver
 * `media/resolveTranscriptionProvider.ts`, configurable por panel) — esta
 * función no sabe ni le importa qué proveedor es.
 */
export interface TranscriptionProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const MIME_A_EXTENSION: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "mp4",
  "audio/amr": "amr",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

/** WhatsApp manda mime_type con parámetros a veces (ej. "audio/ogg; codecs=opus") — se descarta todo lo que no sea el tipo base. */
function extensionParaMime(mimeType: string): string {
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  return MIME_A_EXTENSION[base] ?? "ogg";
}

interface WhisperResponse {
  text?: string;
  error?: { message?: string };
}

export async function transcribirAudio(
  buffer: Buffer,
  mimeType: string,
  config: TranscriptionProviderConfig,
): Promise<string | null> {
  if (!config.apiKey) {
    throw new Error("No hay una API key configurada para el proveedor de transcripción");
  }

  const formData = new FormData();
  const extension = extensionParaMime(mimeType);
  formData.append("file", new Blob([buffer], { type: mimeType }), `audio.${extension}`);
  formData.append("model", config.model);
  // Se fija español — la tienda es colombiana y el prompt del sistema ya
  // asume clientes hispanohablantes; sin esto Whisper a veces detecta mal
  // el idioma en audios cortos o con ruido de fondo.
  formData.append("language", "es");

  const response = await fetchWithTimeout(`${config.baseUrl}/audio/transcriptions`, {
    timeoutMs: env.transcriptionTimeoutMs,
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: formData,
  });

  const body = (await response.json().catch(() => ({}))) as WhisperResponse;
  if (!response.ok) {
    const detalle = body.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`El proveedor de transcripción rechazó el audio: ${detalle}`);
  }

  const texto = body.text?.trim();
  return texto ? texto : null;
}
