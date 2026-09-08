/**
 * Corrige el formato del texto que devuelve el LLM antes de mandarlo por
 * WhatsApp. WhatsApp NO usa markdown estándar: negrita es `*texto*` (un
 * asterisco), no `**texto**`. El system prompt ya le pide esto al modelo
 * explícitamente (ver systemPrompt.ts, sección "Formato de los mensajes"),
 * pero el proveedor activo (DeepSeek, ver ADR-008/project_deepseek_temporal
 * en memoria) no lo respeta siempre — a veces igual genera markdown
 * estándar (`**negrita**`, encabezados `#`). Esta es la garantía
 * determinística de código, independiente de si el modelo obedece o no:
 * complementa el prompt, no lo reemplaza.
 *
 * Puramente sintáctico — no interpreta el contenido, solo normaliza la
 * forma en que ya viene marcado.
 */

/** `**texto**` o `__texto__` → `*texto*` (negrita real de WhatsApp). No toca un `*texto*`/`_texto_` simple, que ya está bien. */
function convertirNegritaMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/__(.+?)__/g, "*$1*");
}

/** `# Encabezado`, `## Encabezado`, etc. (por línea) → `*Encabezado*` — WhatsApp no tiene encabezados, negrita es lo más parecido. */
function convertirEncabezados(text: string): string {
  return text.replace(/^#{1,6}[ \t]+(.+)$/gm, "*$1*");
}

export function sanitizeForWhatsApp(text: string): string {
  if (!text) return text;
  return convertirEncabezados(convertirNegritaMarkdown(text));
}
