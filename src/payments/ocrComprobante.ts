import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";

/**
 * OCR del comprobante de transferencia — llamada puntual a Claude visión,
 * fuera del LLM conversacional (DeepSeek hoy, sin visión — ver
 * `orchestrator/llm/`). Deliberadamente aislado: no toca `ContentBlock` ni
 * `LLMMessage`, mismo criterio que "el texto de la cuenta nunca pasa por
 * el LLM" de `datosTransferencia.ts` — acá lo que no pasa por el LLM
 * conversacional es la imagen entera, no solo el texto de salida.
 *
 * Usa `env.anthropicApiKey` con el mismo modelo por defecto que
 * `anthropicProvider.ts` (ADR-008) — no hay BYOK acá, es infraestructura
 * interna, no una feature configurable por tenant.
 */

export interface ComprobanteAnalizado {
  /** Monto tal como lo leyó el OCR, o `null` si no se pudo leer con certeza. Nunca se inventa un valor. */
  monto: number | null;
  /** Número de cuenta destino tal como aparece en el comprobante, o `null` si no se pudo leer. */
  cuentaDestino: string | null;
}

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const MIME_TYPES_SOPORTADOS: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const PROMPT_EXTRACCION =
  "Esta imagen es un comprobante de transferencia bancaria colombiano (Nequi, Bancolombia, Daviplata u otro). " +
  "Extraé el MONTO transferido (solo el número, sin símbolo de moneda ni separadores de miles ni decimales de centavos) " +
  "y el NÚMERO DE CUENTA DESTINO tal como aparece (puede tener guiones o espacios). " +
  "Si alguno de los dos no se puede leer con certeza, o la imagen no es un comprobante de transferencia, " +
  'poné null en ese campo — nunca inventes ni "completes" un valor que no está claramente legible. ' +
  'Respondé ÚNICAMENTE con un JSON de la forma {"monto": <número o null>, "cuenta_destino": "<string o null>"}, sin texto adicional ni bloque de código.';

/** Por si el modelo igual envuelve la respuesta en ```json — se saca antes de parsear, no se descarta la respuesta entera. */
function extraerJson(texto: string): string {
  const match = texto.match(/\{[\s\S]*\}/);
  return match ? match[0] : texto;
}

function parsearMonto(valor: unknown): number | null {
  if (typeof valor === "number" && Number.isFinite(valor)) {
    return valor;
  }
  if (typeof valor === "string") {
    const limpio = Number(valor.replace(/[^\d.]/g, ""));
    return Number.isFinite(limpio) && limpio > 0 ? limpio : null;
  }
  return null;
}

export async function analizarComprobante(buffer: Buffer, mimeType: string): Promise<ComprobanteAnalizado> {
  if (!env.anthropicApiKey) {
    throw new Error("No hay ANTHROPIC_API_KEY configurada — no se puede leer el comprobante con OCR");
  }
  const mediaType: MediaType = MIME_TYPES_SOPORTADOS.has(mimeType) ? (mimeType as MediaType) : "image/jpeg";

  const client = new Anthropic({ apiKey: env.anthropicApiKey });
  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") },
          },
          { type: "text", text: PROMPT_EXTRACCION },
        ],
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return { monto: null, cuentaDestino: null };
  }

  try {
    const parsed = JSON.parse(extraerJson(textBlock.text)) as {
      monto?: unknown;
      cuenta_destino?: unknown;
    };
    return {
      monto: parsearMonto(parsed.monto),
      cuentaDestino: typeof parsed.cuenta_destino === "string" && parsed.cuenta_destino.trim() ? parsed.cuenta_destino.trim() : null,
    };
  } catch {
    // Respuesta no parseable como JSON — se trata igual que "no se pudo
    // leer" (pedir otra foto), no como un error que tumbe el mensaje.
    return { monto: null, cuentaDestino: null };
  }
}
