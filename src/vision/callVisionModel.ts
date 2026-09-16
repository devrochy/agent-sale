import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";
import { fetchWithTimeout } from "../shared/http/fetchWithTimeout.js";
import { VISION_PROVIDER_CATALOG, type VisionProviderKey } from "./catalog.js";

/**
 * Despachador de proveedores de OCR/visión — un único punto de contacto
 * con la red por proveedor, sin ningún parseo de dominio (eso se queda en
 * `ocrComprobante.ts`/`describirImagenProducto.ts`, que llaman a esto con
 * su propio prompt y siguen parseando la respuesta como ya lo hacían).
 * Devuelve el texto crudo de la respuesta, o `null` si el proveedor
 * respondió sin ningún bloque de texto — nunca decide qué significa ese
 * texto.
 */
export interface VisionProviderConfig {
  providerKey: VisionProviderKey;
  apiKey: string;
  model: string;
}

async function callAnthropicVision(
  config: VisionProviderConfig,
  buffer: Buffer,
  mimeType: string,
  prompt: string,
  maxTokens: number,
): Promise<string | null> {
  // Timeout explícito (ver env.llmTimeoutMs y el incidente 2026-09-13): sin
  // esto el SDK usa su default de ~10 min, y esta llamada corre dentro del
  // mismo consumer secuencial de mensajes que el resto del pipeline.
  const client = new Anthropic({ apiKey: config.apiKey, timeout: env.llmTimeoutMs });
  const response = await client.messages.create({
    model: config.model,
    max_tokens: maxTokens,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: buffer.toString("base64"),
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock && textBlock.type === "text" ? textBlock.text : null;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

async function callGeminiVision(
  config: VisionProviderConfig,
  buffer: Buffer,
  mimeType: string,
  prompt: string,
  maxTokens: number,
): Promise<string | null> {
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
    {
      timeoutMs: env.llmTimeoutMs,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ inlineData: { mimeType, data: buffer.toString("base64") } }, { text: prompt }],
          },
        ],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Error del proveedor Gemini (${config.model}): ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as GeminiGenerateContentResponse;
  const textPart = body.candidates?.[0]?.content?.parts?.find((part) => part.text);
  return textPart?.text ?? null;
}

interface OpenAiCompatibleChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

async function callDeepSeekVision(
  config: VisionProviderConfig,
  buffer: Buffer,
  mimeType: string,
  prompt: string,
  maxTokens: number,
): Promise<string | null> {
  const baseUrl = VISION_PROVIDER_CATALOG.deepseek.baseUrl!;
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    timeoutMs: env.llmTimeoutMs,
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${buffer.toString("base64")}` } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Error del proveedor DeepSeek (${config.model}): ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as OpenAiCompatibleChatResponse;
  return body.choices?.[0]?.message?.content ?? null;
}

export async function callVisionModel(
  config: VisionProviderConfig,
  buffer: Buffer,
  mimeType: string,
  prompt: string,
  maxTokens: number,
): Promise<string | null> {
  switch (config.providerKey) {
    case "anthropic":
      return callAnthropicVision(config, buffer, mimeType, prompt, maxTokens);
    case "gemini":
      return callGeminiVision(config, buffer, mimeType, prompt, maxTokens);
    case "deepseek":
      return callDeepSeekVision(config, buffer, mimeType, prompt, maxTokens);
  }
}
