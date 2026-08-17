import type { EstiloMensajes } from "../orchestrator/behaviorConfig.js";

// Caps generosos, no pensados como límite estricto de UX sino para evitar
// spam de burbujas si el LLM devuelve un texto inusualmente largo/partido.
const MAX_CHUNKS_POCOS_CORTOS = 3;
const MAX_CHUNKS_VARIOS_CORTOS = 6;

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Los últimos chunks que excedan el cap se fusionan en uno solo, en vez de descartarse. */
function capChunks(chunks: string[], max: number): string[] {
  if (chunks.length <= max) {
    return chunks;
  }
  const head = chunks.slice(0, max - 1);
  const tail = chunks.slice(max - 1).join("\n\n");
  return [...head, tail];
}

/**
 * Parte la respuesta del agente en burbujas de WhatsApp según el "Estilo
 * de mensajes" del tenant (Fase 11.4 extendida, ver ADR-021) — post-
 * procesamiento puro, sin tocar el prompt: el SYSTEM_PROMPT ya le pide al
 * LLM separar ideas distintas con un salto de línea en blanco
 * (ver systemPrompt.ts, "Formato de los mensajes"), así que "pocos_cortos"
 * y "varios_cortos" reusan esa estructura en vez de inventar una nueva.
 */
export function splitForBubbles(text: string, estilo: EstiloMensajes): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (estilo === "un_mensaje") {
    return [trimmed];
  }

  const paragraphs = splitParagraphs(trimmed);
  if (paragraphs.length === 0) {
    return [trimmed];
  }

  if (estilo === "pocos_cortos") {
    return capChunks(paragraphs, MAX_CHUNKS_POCOS_CORTOS);
  }

  // varios_cortos: además de por párrafo, parte cada párrafo por oración.
  const sentences = paragraphs.flatMap((paragraph) => splitSentences(paragraph));
  return capChunks(sentences.length > 0 ? sentences : paragraphs, MAX_CHUNKS_VARIOS_CORTOS);
}
