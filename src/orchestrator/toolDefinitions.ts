import type Anthropic from "@anthropic-ai/sdk";

/**
 * Definiciones de las 2 tools implementadas en este incremento (ver
 * docs/fase-1-arquitectura/contratos-tools.md). El resto de las 6 tools
 * documentadas (generar_cotizacion, aplicar_promocion, crear_pedido,
 * recomendar_producto) llegan en el incremento de Fase 6.
 *
 * No llevan `cache_control` propio: el breakpoint va en el último bloque
 * de `system` (docs/fase-4-motor-agente/prompt-caching.md) — el orden de
 * render tools → system → messages hace que ese breakpoint cachee tools
 * y system juntos.
 */
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "consultar_inventario",
    description:
      "Responde disponibilidad y precio de productos del catálogo de ForMotos. Llamar antes de afirmar cualquier precio, stock o disponibilidad.",
    input_schema: {
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
    input_schema: {
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
