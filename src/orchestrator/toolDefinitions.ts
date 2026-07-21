import type { ToolDefinition } from "./llm/types.js";

/**
 * Definiciones de las 2 tools implementadas en este incremento (ver
 * docs/fase-1-arquitectura/contratos-tools.md). El resto de las 6 tools
 * documentadas (generar_cotizacion, aplicar_promocion, crear_pedido,
 * recomendar_producto) llegan en el incremento de Fase 6.
 *
 * Formato neutro (ver ADR-010): cada proveedor de LLM traduce
 * `inputSchema` a su propio formato de tool (Anthropic lo usa casi tal
 * cual; el proveedor openai_compatible lo envuelve en
 * `{type:"function", function:{...}}`).
 *
 * No llevan `cache_control` propio: en el proveedor Anthropic el
 * breakpoint va en el último bloque de `system`
 * (docs/fase-4-motor-agente/prompt-caching.md) — el orden de render
 * tools → system → messages hace que ese breakpoint cachee tools y
 * system juntos.
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "consultar_inventario",
    description:
      "Responde disponibilidad y precio de productos del catálogo de ForMotos. Llamar antes de afirmar cualquier precio, stock o disponibilidad.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Término de búsqueda libre, ej. 'casco talla M'.",
        },
        sku: {
          type: "string",
          description: "SKU exacto si el cliente ya lo especificó.",
        },
      },
    },
  },
  {
    name: "escalar_a_humano",
    description:
      "Registra la conversación para que un asesor humano de ForMotos la atienda. Usar ante una queja, una solicitud directa de hablar con una persona, una pregunta de compatibilidad técnica que no se pueda resolver con las tools disponibles, o varios intentos fallidos de ayudar al cliente.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          enum: [
            "compatibilidad_tecnica",
            "monto_alto",
            "solicitud_cliente",
            "intentos_fallidos",
            "queja",
          ],
          description: "Motivo del escalamiento.",
        },
        summary: {
          type: "string",
          description: "Resumen breve de la conversación para el asesor.",
        },
      },
      required: ["reason", "summary"],
    },
  },
];
