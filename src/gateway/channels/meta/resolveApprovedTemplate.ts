import type { ResolvedConnection } from "../../../shared/db/connectionsDirectory.js";
import { getConnection } from "../../../shared/db/index.js";
import {
  listTemplates,
  type WhatsAppTemplateRecord,
} from "../../../shared/db/whatsappTemplatesDirectory.js";

export type ResolveApprovedTemplateResult =
  | { ok: true; connection: ResolvedConnection; template: WhatsAppTemplateRecord }
  | { ok: false; status: "canal_no_soportado" | "plantilla_no_aprobada" };

/**
 * Busca la conexión de Meta/WhatsApp y, dentro de ella, una plantilla
 * aprobada con ese nombre — el primer paso que repite cada disparador de
 * plantilla proactiva del proyecto (cierre de pedido, método de pago,
 * confirmación de domicilio, pago aprobado/rechazado, pedido en camino,
 * pedido cancelado, reactivación de cotizaciones frías). Nace acá y no
 * copiado en cada uno porque ya eran 7 lugares repitiendo el mismo chequeo
 * (ver cerrarPedido.ts, que lo tenía inline antes de este refactor).
 *
 * Las plantillas de Meta solo aplican a WhatsApp Cloud API — Twilio
 * gestiona las suyas por fuera de este proyecto (ver el docblock de
 * templates.ts), y ni Instagram ni Messenger tienen plantillas.
 */
export async function resolveApprovedTemplate(
  connectionId: string | null,
  templateName: string,
): Promise<ResolveApprovedTemplateResult> {
  if (!connectionId) {
    return { ok: false, status: "canal_no_soportado" };
  }
  const connection = await getConnection(connectionId);
  if (!connection || connection.provider !== "meta" || connection.channel !== "whatsapp") {
    return { ok: false, status: "canal_no_soportado" };
  }
  const template = (await listTemplates(connection.id)).find(
    (t) => t.name === templateName && t.status === "approved",
  );
  if (!template) {
    return { ok: false, status: "plantilla_no_aprobada" };
  }
  return { ok: true, connection, template };
}

/**
 * Índice del botón URL con variable dinámica dentro de `template.components`
 * (ver adminPanel.ts -> buildButtonsComponent: siempre hay como mucho un
 * botón URL, y siempre va al final del arreglo si existe). `-1` si la
 * plantilla no tiene botón URL.
 */
export function findUrlButtonIndex(template: WhatsAppTemplateRecord): number {
  const botones = (
    template.components.find((c) => c.type === "BUTTONS") as { buttons?: { type?: string }[] } | undefined
  )?.buttons;
  return botones?.findIndex((b) => b.type === "URL") ?? -1;
}
