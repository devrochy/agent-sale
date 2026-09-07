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
              variant_id: {
                type: "string",
                description:
                  "UUID de la variante concreta (de consultar_inventario) — si el producto tiene más de una variante activa, preguntar cuál antes de cotizar.",
              },
              quantity: { type: "integer", description: "Cantidad solicitada, mayor que 0." },
            },
            required: ["variant_id", "quantity"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "aplicar_promocion",
    description:
      "Evalúa las promociones activas contra una cotización existente (por aliado, categoría, producto, variante, segmento de cliente o campaña de bienvenida, según cómo esté configurada cada una) y aplica automáticamente la de mayor beneficio para el cliente (nunca se combinan promociones). Llamar apenas se genera una cotización, aunque sea preliminar, para poder mencionar proactivamente un descuento si aplica — y también cuando el cliente pregunta por descuentos o promociones sobre una cotización ya generada.",
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
          enum: ["transferencia", "efectivo_contraentrega", "tarjeta", "pago_en_linea"],
          description:
            "Método de pago acordado con el cliente. 'pago_en_linea' genera un link de pago seguro (tarjeta, PSE, Nequi o transferencia Bancolombia) que se confirma automáticamente al pagarse — úsalo cuando el cliente prefiera pagar antes del envío sin mandar comprobante manual.",
        },
        delivery_method: {
          type: "string",
          enum: ["domicilio", "recoger_en_tienda"],
          description: "Método de entrega acordado con el cliente.",
        },
        customer_data: {
          type: "object",
          description:
            "Datos de entrega del cliente para este pedido. Requerido para que el pedido quede confirmado — si no se manda (o falta alguno), la tool devuelve status 'faltan_datos_cliente' con lo que ya haya guardado (existing_data) y qué falta (missing_fields), sin confirmar nada. Nunca reutilices en silencio datos guardados de un pedido anterior: confirmá explícitamente con el cliente (ej. '¿tu dirección sigue siendo la misma?') antes de volver a llamar la tool con customer_data.",
          properties: {
            address: { type: "string", description: "Dirección de entrega." },
            id_document: { type: "string", description: "Número de cédula o documento de identidad." },
            full_name: {
              type: "string",
              description: "Nombre completo para la entrega (puede diferir del nombre de WhatsApp).",
            },
            municipality: { type: "string", description: "Municipio, si el cliente lo menciona (opcional)." },
            city: { type: "string", description: "Ciudad, si el cliente lo menciona (opcional)." },
            phone: {
              type: "string",
              description:
                "Teléfono de contacto. Solo pedilo si 'phone' aparece en missing_fields — pasa cuando el cliente escribe por Instagram o Messenger, donde no tenemos su número. Por WhatsApp ya lo tenemos y no hay que preguntarlo.",
            },
            save_permanently: {
              type: "boolean",
              description: "true si el cliente aceptó guardar estos datos para futuros pedidos.",
            },
          },
          required: ["address", "id_document", "full_name", "save_permanently"],
        },
      },
      required: ["quote_id", "payment_method", "delivery_method"],
    },
  },
  {
    name: "agregar_item_pedido",
    description:
      "Suma productos a un pedido ya confirmado en la misma conversación, mientras siga abierto (todavía no despachado) — sin crear un pedido ni una cotización nueva. Usar cuando el cliente pide agregar algo más después de que crear_pedido ya devolvió status 'confirmed'. Vuelve a validar precio y stock reales, igual que generar_cotizacion.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "UUID del pedido ya confirmado (de crear_pedido)." },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              variant_id: {
                type: "string",
                description:
                  "UUID de la variante concreta (de consultar_inventario) — si el producto tiene más de una variante activa, preguntar cuál antes de agregarla.",
              },
              quantity: { type: "integer", description: "Cantidad solicitada, mayor que 0." },
            },
            required: ["variant_id", "quantity"],
          },
        },
      },
      required: ["order_id", "items"],
    },
  },
  {
    name: "preguntar_metodo_pago",
    description:
      "Manda la plantilla de WhatsApp 'metodo_pago' con 3 botones (Transferencia / Pago en línea / Contra entrega) para que el cliente elija cómo pagar, en vez de preguntarlo por texto libre. Llamar cuando el cliente confirme que quiere comprar y todavía no haya dicho el método de pago. Cuando responda con uno de los 3 botones, mapealo a payment_method ('Transferencia'→'transferencia', 'Pago en línea'→'pago_en_linea', 'Contra entrega'→'efectivo_contraentrega') y seguí a crear_pedido con ese valor — no vuelvas a preguntar. Si devuelve 'status' distinto de 'enviado', no reintentes: preguntá el método de pago por texto normal.",
    inputSchema: {
      type: "object",
      properties: {
        quote_id: { type: "string", description: "UUID de la cotización sobre la que se va a confirmar el pedido." },
      },
      required: ["quote_id"],
    },
  },
  {
    name: "confirmar_domicilio_pedido",
    description:
      "Marca la dirección de un pedido como confirmada por el cliente. Llamar cuando el cliente responde 'Confirmar dirección' (el botón de la plantilla 'confirmar_domicilio' que se manda junto con cerrar_pedido) — no hace falta volver a preguntar nada, tocar el botón ya es la confirmación. El pedido no se puede despachar hasta que esto pase.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "UUID del pedido cuya dirección se confirma." },
      },
      required: ["order_id"],
    },
  },
  {
    name: "actualizar_direccion_pedido",
    description:
      "Cambia la dirección de entrega de un pedido abierto. Llamar cuando el cliente responde 'Cambiar temporalmente' o 'Cambiar permanentemente' al botón de la plantilla 'confirmar_domicilio' — en cualquiera de los dos casos, primero pedile la dirección nueva por texto (nunca asumas una). Cuando la dé, llamá esta tool con 'order_id', 'direccion_nueva', y 'guardar_permanente' en true solo si tocó 'Cambiar permanentemente' (para que quede guardada en su perfil para próximos pedidos), false si tocó 'Cambiar temporalmente' (solo aplica a este pedido). Si devuelve 'pedido_no_abierto', avisale que ese pedido ya no admite cambios de dirección.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "UUID del pedido cuya dirección se cambia." },
        direccion_nueva: { type: "string", description: "Dirección de entrega nueva, tal como la dio el cliente." },
        guardar_permanente: {
          type: "boolean",
          description: "true si el cliente tocó 'Cambiar permanentemente' (se guarda también en su perfil); false si tocó 'Cambiar temporalmente'.",
        },
      },
      required: ["order_id", "direccion_nueva", "guardar_permanente"],
    },
  },
  {
    name: "cerrar_pedido",
    description:
      "Manda la plantilla de WhatsApp 'pedido_confirmado' (resumen del pedido con 3 botones: Agregar productos, Cancelar pedido, Confirmar y pagar) y termina el turno esperando la respuesta del cliente. Llamar cuando el cliente confirme que ya no quiere agregar nada más a un pedido abierto (creado con crear_pedido, quizás ampliado con agregar_item_pedido) y esté listo para cerrarlo — en vez de redactar vos el resumen final, esta tool se lo manda con las 3 opciones ya armadas. Si el cliente responde con texto pidiendo agregar algo, usa agregar_item_pedido; si pide cancelar, usa cancelar_pedido; si toca 'Confirmar y pagar', usa confirmar_pago_pedido con el order_id. Si devuelve 'plantilla_no_aprobada' o 'canal_no_soportado', no repitas el intento: seguí la conversación por texto normal, resumiendo vos el pedido y preguntando cómo quiere continuar.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "UUID del pedido abierto a cerrar (de crear_pedido)." },
      },
      required: ["order_id"],
    },
  },
  {
    name: "confirmar_pago_pedido",
    description:
      "Resuelve el botón 'Confirmar y pagar' de la plantilla 'pedido_confirmado' según el método de pago que el cliente ya eligió al crear el pedido — no hace falta volver a preguntarlo. Llamar cuando el cliente toca ese botón, con el 'order_id'. Según 'status': 'datos_transferencia_enviados' → ya se le mandaron los datos de la cuenta en un mensaje aparte (mismo criterio que crear_pedido: nunca escribas vos un número de cuenta), confirmale que 'te acabo de pasar los datos' y pedile el comprobante. 'sin_cuentas_configuradas' → la tienda todavía no cargó ninguna cuenta, decile que en un momento le pasan los datos y usa escalar_a_humano. 'link_pago_disponible' → el link ya se agrega solo al final de tu respuesta (nunca lo escribas vos), solo explicá que el pedido queda pendiente hasta que pague ese link. 'sin_link_pago' → avisale que hubo un problema generando el link y usa escalar_a_humano. 'ya_pagado' → confirmale que el pago ya está registrado, no hace falta pagar de nuevo. 'sin_pago_pendiente' (pago contra entrega) → recordale que no hay nada que pagar ahora, paga en efectivo al recibir. 'pedido_cancelado' → avisale que ese pedido ya no está activo. 'pedido_no_encontrado' → algo no cuadra, no inventes nada y escalá si insiste.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "UUID del pedido cuyo pago se confirma." },
      },
      required: ["order_id"],
    },
  },
  {
    name: "cancelar_pedido",
    description:
      "Cancela un pedido todavía abierto — no revierte pagos ni libera stock, solo cambia su estado. Llamar cuando el cliente pida cancelar explícitamente (por texto, o al tocar el botón 'Cancelar pedido' del resumen que manda cerrar_pedido).",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "UUID del pedido a cancelar." },
        reason: { type: "string", description: "Motivo que dio el cliente, si lo dijo (opcional)." },
      },
      required: ["order_id"],
    },
  },
  {
    name: "consultar_estado_pedido",
    description:
      "Responde el estado real de un pedido ya hecho por el cliente, a partir de su número público (formato 'FM-0001'). Llamar cuando el cliente pregunte cómo va su pedido — nunca inventar ni asumir el estado. Si devuelve found:false, pedirle al cliente que confirme el número o avisarle que no se encontró.",
    inputSchema: {
      type: "object",
      properties: {
        public_order_number: {
          type: "string",
          description: "Número público del pedido que menciona el cliente, ej. 'FM-0001' (acepta variantes como 'fm1' o 'FM 0001').",
        },
      },
      required: ["public_order_number"],
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
