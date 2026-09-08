/**
 * Transcripción de audio entrante (notas de voz de WhatsApp) — Whisper de
 * OpenAI, llamada directa sin SDK (mismo criterio que Wompi/Meta, ADR-033:
 * una dependencia no se paga por un solo endpoint). Aislado del LLM
 * conversacional (DeepSeek hoy) igual que `ocrComprobante.ts` — ninguno de
 * los proveedores ya conectados transcribe audio.
 *
 * Devuelve `null` (no lanza) cuando Whisper no pudo sacar nada en limpio
 * (silencio, ruido, audio corrupto) — es un resultado válido, no un error;
 * el caller (`mediaIngestion.ts`) le pide al cliente que lo reenvíe o lo
 * escriba. Si la llamada a la API falla de verdad (red, auth, 5xx), sí
 * lanza — ese caso lo reintenta el consumer de la cola.
 *
 * No resuelve la API key acá adentro (a diferencia de `ocrComprobante.ts`,
 * que sí lee `env.anthropicApiKey` directo): la key de OpenAI es BYOK
 * configurable desde el panel (`settingsDirectory.ts` →
 * `getOpenAiConfig`), con `env.openaiApiKey` como fallback — esa resolución
 * vive en el caller (`mediaIngestion.ts`) para no acoplar esta función,
 * fácil de testear en aislado, a la base de datos.
 */

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

export async function transcribirAudio(buffer: Buffer, mimeType: string, apiKey: string): Promise<string | null> {
  if (!apiKey) {
    throw new Error("No hay OPENAI_API_KEY configurada — no se puede transcribir audio");
  }

  const formData = new FormData();
  const extension = extensionParaMime(mimeType);
  formData.append("file", new Blob([buffer], { type: mimeType }), `audio.${extension}`);
  formData.append("model", "whisper-1");
  // Se fija español — la tienda es colombiana y el prompt del sistema ya
  // asume clientes hispanohablantes; sin esto Whisper a veces detecta mal
  // el idioma en audios cortos o con ruido de fondo.
  formData.append("language", "es");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  const body = (await response.json().catch(() => ({}))) as WhisperResponse;
  if (!response.ok) {
    const detalle = body.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`OpenAI rechazó la transcripción del audio: ${detalle}`);
  }

  const texto = body.text?.trim();
  return texto ? texto : null;
}
