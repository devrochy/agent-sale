import { withTransaction } from "../../shared/db/index.js";
import { canonicalToMetaRecipient } from "../../gateway/channels/meta/addresses.js";
import { resolveApprovedTemplate } from "../../gateway/channels/meta/resolveApprovedTemplate.js";
import { sendTemplateMessage } from "../../gateway/channels/meta/templates.js";

export interface PreguntarMetodoPagoInput {
  quote_id: string;
}

export type PreguntarMetodoPagoStatus = "enviado" | "cotizacion_no_encontrada" | "canal_no_soportado" | "plantilla_no_aprobada";

export interface PreguntarMetodoPagoOutput {
  quote_id: string;
  status: PreguntarMetodoPagoStatus;
}

function formatearMonto(total: number): string {
  return `$${total.toLocaleString("es-CO")}`;
}

interface QuoteRow {
  conversation_id: string;
  customer_full_name: string | null;
  customer_external_id: string;
  connection_id: string | null;
  total: string;
}

/**
 * Tool preguntar_metodo_pago — reemplaza el "¿cómo querés pagar?" de texto
 * libre por la plantilla "metodo_pago" con 3 botones de respuesta rápida
 * (Transferencia / Pago en línea / Contra entrega, en ese orden — ver
 * systemPrompt.ts para el mapeo exacto texto→payment_method). Se llama
 * sobre una cotización, no un pedido: en este punto del flujo el pedido
 * todavía no existe (payment_method es un input obligatorio de
 * crear_pedido), así que no hay order_id ni botón URL que armar — solo el
 * nombre del cliente y el total, igual que hace cerrarPedido.ts con
 * pedido_confirmado pero una cotización más temprano en el flujo.
 */
export async function preguntarMetodoPago(
  input: PreguntarMetodoPagoInput,
): Promise<PreguntarMetodoPagoOutput> {
  const quote = await withTransaction(async (client) => {
    const result = await client.query<QuoteRow>(
      `SELECT q.conversation_id, c.full_name AS customer_full_name,
              c.external_id AS customer_external_id, conv.connection_id, q.total
         FROM quotes q
         JOIN customers c ON c.id = q.customer_id
         JOIN conversations conv ON conv.id = q.conversation_id
        WHERE q.id = $1`,
      [input.quote_id],
    );
    return result.rows[0] ?? null;
  });

  if (!quote) {
    return { quote_id: input.quote_id, status: "cotizacion_no_encontrada" };
  }

  const resuelta = await resolveApprovedTemplate(quote.connection_id, "metodo_pago");
  if (!resuelta.ok) {
    return { quote_id: input.quote_id, status: resuelta.status };
  }

  await sendTemplateMessage(
    resuelta.connection.credentials,
    resuelta.connection.externalId,
    canonicalToMetaRecipient(quote.customer_external_id),
    "metodo_pago",
    resuelta.template.language,
    [
      {
        type: "body",
        parameters: [
          { type: "text", text: quote.customer_full_name || "cliente" },
          { type: "text", text: formatearMonto(Number(quote.total)) },
        ],
      },
    ],
  );

  return { quote_id: input.quote_id, status: "enviado" };
}
