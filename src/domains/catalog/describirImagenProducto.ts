import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env.js";

/**
 * Descripción de una foto de producto — llamada puntual a Claude visión,
 * fuera del LLM conversacional (mismo criterio que `ocrComprobante.ts`).
 * La descripción resultante reemplaza el body del mensaje como si el
 * cliente la hubiera tipeado (ver `orchestrator/mediaIngestion.ts`).
 */

const PROMPT_DESCRIPCION =
  "Esta es una foto que un cliente le mandó a una tienda colombiana de accesorios y repuestos de motocicleta " +
  "(cascos, guantes, chaquetas, baúles, cámaras, llantas, etc.). " +
  "Si la foto muestra un producto identificable de ese tipo, describilo en pocas palabras aptas para buscar en " +
  "un catálogo: tipo de producto primero, después color/material/detalles visibles que ayuden a encontrarlo " +
  '(ej. "casco integral negro con visor ahumado", "guantes de cuero café"). No inventes una marca si no se ' +
  "ve claramente. Si la foto no muestra ningún producto reconocible, está borrosa, o no tiene nada que ver con " +
  "motos, poné null en ese campo — nunca inventes ni \"completes\" una descripción de algo que no se ve con claridad. " +
  'Respondé ÚNICAMENTE con un JSON de la forma {"producto": "<descripción corta>" o null}, sin texto adicional ni bloque de código.';

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const MIME_TYPES_SOPORTADOS: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Por si el modelo igual envuelve la respuesta en ```json — se saca antes de parsear, no se descarta la respuesta entera. */
function extraerJson(texto: string): string {
  const match = texto.match(/\{[\s\S]*\}/);
  return match ? match[0] : texto;
}

/**
 * Parsea la respuesta de texto de Claude. Deliberadamente basado en JSON
 * (igual que `ocrComprobante.ts`) en vez de comparar contra el string
 * literal "null": un modelo que no respeta el formato al pie de la letra
 * (ej. "No veo ningún producto en la foto.") antes se colaba como una
 * descripción de búsqueda válida en vez de tratarse como "no identificado".
 */
export function parsearDescripcion(texto: string): string | null {
  if (!texto.trim()) return null;
  try {
    const parsed = JSON.parse(extraerJson(texto)) as { producto?: unknown };
    return typeof parsed.producto === "string" && parsed.producto.trim() ? parsed.producto.trim() : null;
  } catch {
    // Respuesta no parseable como JSON — se trata igual que "no se pudo
    // identificar" (pedir otra foto), no como un error que tumbe el mensaje.
    return null;
  }
}

export async function describirImagenProducto(buffer: Buffer, mimeType: string): Promise<string | null> {
  if (!env.anthropicApiKey) {
    throw new Error("No hay ANTHROPIC_API_KEY configurada — no se puede describir la imagen");
  }
  const mediaType: MediaType = MIME_TYPES_SOPORTADOS.has(mimeType) ? (mimeType as MediaType) : "image/jpeg";
  const client = new Anthropic({ apiKey: env.anthropicApiKey });
  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 100,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") } },
          { type: "text", text: PROMPT_DESCRIPCION },
        ],
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return null;
  }
  return parsearDescripcion(textBlock.text);
}
