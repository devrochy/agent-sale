import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env.js";

/**
 * Búsqueda por foto de producto (Fase 3 del plan de "medios entrantes") —
 * convierte la foto que manda el cliente en una descripción corta de
 * texto, que se trata después como si el cliente la hubiera tipeado (ver
 * `orchestrator/mediaIngestion.ts` y el bloque nuevo de `systemPrompt.ts`).
 * El LLM sigue decidiendo qué tool llamar con esa descripción — acá no se
 * agrega ninguna tool nueva, ni un motor de similitud visual real.
 *
 * Deliberadamente NO es un motor de embeddings/similitud: hoy no hay
 * proveedor de embeddings elegido, `products.embedding` existe desde la
 * Fase 5 pero nunca se pobló, y el seed de prueba usa placeholders de
 * picsum.photos en vez de fotos reales — construir esa ruta ahora sería
 * código que nunca podría ejercitarse de verdad (mismo criterio que
 * `recomendarProducto.ts` documenta para su propio caso). Cuando la tienda
 * tenga fotos reales de catálogo y se justifique el gasto de un proveedor
 * de embeddings, esa es la mejora natural — ver ADR-026 y el plan
 * guardado en memoria del proyecto.
 *
 * Aislado del LLM conversacional (DeepSeek hoy, sin visión) igual que
 * `ocrComprobante.ts` — misma llamada puntual a Claude visión.
 */

const PROMPT_DESCRIPCION =
  "Esta es una foto que un cliente le mandó a una tienda colombiana de accesorios y repuestos de motocicleta " +
  "(cascos, guantes, chaquetas, baúles, cámaras, llantas, etc.). " +
  "Si la foto muestra un producto identificable de ese tipo, describilo en pocas palabras aptas para buscar en " +
  "un catálogo: tipo de producto primero, después color/material/detalles visibles que ayuden a encontrarlo " +
  "(ej. \"casco integral negro con visor ahumado\", \"guantes de cuero café\"). No inventes una marca si no se " +
  "ve claramente. Si la foto no muestra ningún producto reconocible, está borrosa, o no tiene nada que ver con " +
  'motos, respondé exactamente la palabra "null" — nada de comillas ni texto alrededor. Respondé SOLO con la ' +
  'descripción corta o con "null", una sola línea, sin explicaciones.';

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const MIME_TYPES_SOPORTADOS: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Pura, sin red — separada para poder testear el parseo sin mockear el SDK de Anthropic. */
export function parsearDescripcion(content: Array<{ type: string; text?: string }>): string | null {
  const textBlock = content.find((block) => block.type === "text");
  if (!textBlock?.text) {
    return null;
  }
  const texto = textBlock.text.trim();
  if (!texto || texto.toLowerCase() === "null") {
    return null;
  }
  return texto;
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

  return parsearDescripcion(response.content);
}
