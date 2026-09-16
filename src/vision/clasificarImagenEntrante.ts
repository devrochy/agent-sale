import { callVisionModel, type VisionProviderConfig } from "./callVisionModel.js";

/**
 * Clasificación previa a la bifurcación comprobante vs. producto (ver
 * `orchestrator/mediaIngestion.ts`), solo para el caso de un pedido
 * genuinamente pendiente de comprobante (no escalado — ver
 * `buscarPedidoPendienteTransferencia`). Antes de esto, la bifurcación era
 * 100% por estado de negocio y nunca miraba el contenido de la imagen: si
 * el cliente mandaba la foto de un producto mientras tenía un pago
 * pendiente real, igual se intentaba leer como comprobante.
 *
 * Fail-safe conservador: ante cualquier error o respuesta ambigua, se
 * asume "comprobante" — es un control financiero (mismo criterio que el
 * resto de `procesarComprobante.ts`), nunca hay que perder de vista un
 * pago real por un fallo de clasificación. Solo se devuelve "producto"
 * cuando el modelo está seguro de que NO es un comprobante.
 */
export type TipoImagenEntrante = "comprobante" | "producto";

const PROMPT = `Mirá esta imagen y decidí si es UNA de estas dos cosas:
- "comprobante": una captura de pantalla o foto de un comprobante bancario/de transferencia (muestra un banco, una app de banco, un monto, una cuenta, una referencia o similar).
- "producto": la foto de un producto físico (moto, casco, repuesto, accesorio, etc.), sin relación con un pago o transferencia.

Respondé ÚNICAMENTE con un JSON de una sola línea, sin texto adicional: {"tipo": "comprobante"} o {"tipo": "producto"}.
Si no estás seguro, respondé {"tipo": "comprobante"}.`;

function parsearTipo(texto: string | null): TipoImagenEntrante {
  if (!texto) return "comprobante";
  const match = texto.match(/\{[^}]*\}/);
  if (!match) return "comprobante";
  try {
    const parsed = JSON.parse(match[0]) as { tipo?: unknown };
    return parsed.tipo === "producto" ? "producto" : "comprobante";
  } catch {
    return "comprobante";
  }
}

export async function clasificarImagenEntrante(
  buffer: Buffer,
  mimeType: string,
  visionConfig: VisionProviderConfig,
): Promise<TipoImagenEntrante> {
  try {
    const texto = await callVisionModel(visionConfig, buffer, mimeType, PROMPT, 50);
    return parsearTipo(texto);
  } catch {
    return "comprobante";
  }
}
