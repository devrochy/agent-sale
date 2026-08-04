import {
  consultarInventario,
  type ConsultarInventarioInput,
} from "../domains/catalog/consultarInventario.js";
import {
  aplicarPromocion,
  type AplicarPromocionInput,
} from "../domains/commerce/aplicarPromocion.js";
import { crearPedido, type CrearPedidoInput } from "../domains/commerce/crearPedido.js";
import {
  agregarItemPedido,
  type AgregarItemPedidoInput,
} from "../domains/commerce/agregarItemPedido.js";
import {
  consultarEstadoPedido,
  type ConsultarEstadoPedidoInput,
} from "../domains/commerce/consultarEstadoPedido.js";
import {
  generarCotizacion,
  type GenerarCotizacionInput,
} from "../domains/commerce/generarCotizacion.js";
import {
  recomendarProducto,
  type RecomendarProductoInput,
} from "../domains/commerce/recomendarProducto.js";
import { escalarHumano, type EscalarHumanoInput } from "../domains/escalation/escalarHumano.js";
import { recordAudit } from "../shared/audit/auditLog.js";
import { logger } from "../shared/observability/logger.js";
import type { ContentBlock } from "./llm/types.js";

type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;
type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;

/**
 * Ejecuta la tool que el LLM propuso y devuelve el tool_result real (ver
 * docs/fase-4-motor-agente/auditoria.md: el audit_log refleja lo que la
 * tool realmente hizo, no lo que el modelo dijo que iba a hacer).
 * `customerId` y `messageSid` son contexto inyectado por el orquestador
 * (nunca expuesto al LLM) — el primero para generar_cotizacion, el
 * segundo para el idempotency_key de crear_pedido/agregar_item_pedido.
 * `montoAltoThreshold` también lo inyecta el orquestador, lo usan
 * crear_pedido y agregar_item_pedido (ver crearPedido.ts/
 * agregarItemPedido.ts) para negarse a confirmar un pedido de monto alto
 * en vez de confirmarlo y recién después decidir escalar.
 */
export async function executeTool(
  conversationId: string,
  customerId: string,
  messageSid: string,
  montoAltoThreshold: number,
  toolUse: ToolUseBlock,
): Promise<ToolResultBlock> {
  const toolLogger = logger.child({ conversation_id: conversationId });
  const startedAt = Date.now();
  toolLogger.info(
    { event: "orchestrator.tool_iniciada", tool: toolUse.name },
    "Ejecución de tool iniciada",
  );

  try {
    let output: unknown;
    switch (toolUse.name) {
      case "consultar_inventario":
        output = await consultarInventario(toolUse.input as ConsultarInventarioInput);
        break;
      case "generar_cotizacion":
        output = await generarCotizacion(
          conversationId,
          customerId,
          toolUse.input as GenerarCotizacionInput,
        );
        break;
      case "aplicar_promocion":
        output = await aplicarPromocion(toolUse.input as AplicarPromocionInput);
        break;
      case "crear_pedido":
        output = await crearPedido(messageSid, toolUse.input as CrearPedidoInput, montoAltoThreshold);
        break;
      case "agregar_item_pedido":
        output = await agregarItemPedido(
          messageSid,
          toolUse.input as AgregarItemPedidoInput,
          montoAltoThreshold,
        );
        break;
      case "consultar_estado_pedido":
        output = await consultarEstadoPedido(customerId, toolUse.input as ConsultarEstadoPedidoInput);
        break;
      case "recomendar_producto":
        output = await recomendarProducto(toolUse.input as RecomendarProductoInput);
        break;
      case "escalar_a_humano":
        output = await escalarHumano(conversationId, toolUse.input as EscalarHumanoInput);
        break;
      default:
        throw new Error(`Tool desconocida: ${toolUse.name}`);
    }

    await recordAudit(conversationId, "tool", toolUse.name, toolUse.input, output);
    toolLogger.info(
      { event: "orchestrator.tool_completada", tool: toolUse.name, latency_ms: Date.now() - startedAt },
      "Ejecución de tool completada",
    );

    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: JSON.stringify(output),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordAudit(conversationId, "tool", toolUse.name, toolUse.input, {
      error: message,
    });
    toolLogger.warn(
      {
        event: "orchestrator.tool_completada",
        tool: toolUse.name,
        latency_ms: Date.now() - startedAt,
        is_error: true,
        error: message,
      },
      "Ejecución de tool completada con error",
    );
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: message,
      is_error: true,
    };
  }
}
