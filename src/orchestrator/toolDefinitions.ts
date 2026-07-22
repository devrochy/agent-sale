import type { ToolDefinition } from "./llm/types.js";

/**
 * Definiciones de las 6 tools de docs/fase-1-arquitectura/contratos-tools.md.
 *
 * `crear_pedido` deja fuera `idempotency_key` del schema que ve el LLM a
 * propósito (ver domains/commerce/crearPedido.ts): el orquestador lo
 * inyecta a partir del message_sid, igual que tenant_id/conversation_id —
 * un valor propuesto por el modelo no sería estable entre reintentos.
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
    name: "generar_cotizacion",
    description:
      "Crea una cotización a partir de una lista de productos y cantidades. Vuelve a validar precio y stock reales — llamar cuando el cliente confirma qué productos y cantidades quiere cotizar. No aplica promociones (usar aplicar_promocion después).",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              product_id: {
                type: "string",
                description: "UUID del producto (de consultar_inventario).",
              },
              quantity: { type: "integer", description: "Cantidad solicitada, mayor que 0." },
            },
            required: ["product_id", "quantity"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "aplicar_promocion",
    description:
      "Evalúa las promociones activas del tenant contra una cotización existente y aplica automáticamente la de mayor beneficio para el cliente (nunca se combinan promociones). Llamar cuando el cliente pregunta por descuentos o promociones sobre una cotización ya generada.",
    inputSchema: {
      type: "object",
      properties: {
        quote_id: { type: "string", description: "UUID de la cotización (de generar_cotizacion)." },
        promo_code: {
          type: "string",
          description: "Código de promoción si el cliente lo menciona (opcional, informativo).",
        },
      },
      required: ["quote_id"],
    },
  },
  {
    name: "crear_pedido",
    description:
      "Convierte una cotización aceptada por el cliente en un pedido confirmado. Llamar solo después de que el cliente confirme explícitamente que quiere comprar, con método de pago y de entrega ya acordados.",
    inputSchema: {
      type: "object",
      properties: {
        quote_id: { type: "string", description: "UUID de la cotización a confirmar." },
        payment_method: {
          type: "string",
          enum: ["transferencia", "efectivo_contraentrega", "tarjeta"],
          description: "Método de pago acordado con el cliente.",
        },
        delivery_method: {
          type: "string",
          enum: ["domicilio", "recoger_en_tienda"],
          description: "Método de entrega acordado con el cliente.",
        },
      },
      required: ["quote_id", "payment_method", "delivery_method"],
    },
  },
  {
    name: "recomendar_producto",
    description:
      "Sugiere productos relacionados o complementarios (ej. guantes para quien compra un casco). Llamar después de que el cliente muestre interés en un producto concreto, para ofrecer venta cruzada relevante.",
    inputSchema: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description: "Texto breve de la conversación reciente, si no hay un product_id claro.",
        },
        product_id: {
          type: "string",
          description: "UUID del producto que el cliente ya está viendo o compró, si aplica.",
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
            "fuera_de_alcance",
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
