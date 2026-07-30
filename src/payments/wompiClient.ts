const SANDBOX_API_BASE = "https://sandbox.wompi.co/v1";
const PRODUCTION_API_BASE = "https://production.wompi.co/v1";
const CHECKOUT_BASE = "https://checkout.wompi.co/l";

// Wompi expone sandbox/producción como hosts distintos, seleccionados por
// el prefijo de la llave (prv_test_/prv_prod_) — así se evita un campo de
// "ambiente" redundante en la config del tenant (ver ADR-024).
function resolveApiBase(privateKey: string): string {
  if (privateKey.startsWith("prv_test_")) {
    return SANDBOX_API_BASE;
  }
  if (privateKey.startsWith("prv_prod_")) {
    return PRODUCTION_API_BASE;
  }
  throw new Error(
    "Llave privada de Wompi con prefijo desconocido (se esperaba prv_test_ o prv_prod_)",
  );
}

// Vencimiento del link: mismo espíritu de ventana acotada que ADR-019
// (mensajería proactiva dentro de 24h) — un link viejo no debería quedar
// pagable indefinidamente sobre un pedido que ya pudo cambiar.
const LINK_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/**
 * Mínimo real de Wompi para la base de una transacción en COP — no
 * documentado explícitamente en la guía de Links de pago, descubierto en
 * QA contra el sandbox real (POST /v1/payment_links devolvió 422:
 * "La base de la transacción debe ser igual o mayor a 150000..."). Se
 * exporta para que crearPedido.ts pueda chequearlo *antes* de llamar a la
 * API (evita una llamada de red que sabemos que va a fallar) y para que
 * "Probar y guardar" (ver adminPanel.ts) use un monto de prueba válido.
 */
export const MIN_AMOUNT_COP = 150000;

export interface WompiPaymentLink {
  paymentLinkId: string;
  url: string;
}

/**
 * Crea un link de pago de un solo uso (POST /v1/payment_links, ver
 * docs.wompi.co/en/docs/colombia/links-de-pago) — cubre tarjeta, PSE,
 * Nequi y transferencia Bancolombia bajo el mismo link y el mismo
 * webhook `transaction.updated` (ver wompiWebhookHandler.ts), sin que el
 * pedido necesite saber cuál de esos métodos usó el cliente. Deliberadamente
 * sin `redirect_url`: Wompi ya muestra su propia pantalla de confirmación,
 * no hace falta una página propia para esto (a diferencia de
 * src/reviews/reviewView.ts, que sí necesita capturar texto).
 *
 * `amountCop` es el monto en pesos (no centavos) — igual que
 * `orders.total`/`quotes.total`, `numeric(12,2)`. Se llama fuera de
 * cualquier `withTenant` (ver crearPedido.ts): es una llamada de red
 * externa, y el patrón ya establecido en escalarHumano.ts es no mantener
 * una transacción abierta durante una llamada así.
 */
export async function createPaymentLink(
  privateKey: string,
  description: string,
  amountCop: number,
): Promise<WompiPaymentLink> {
  const apiBase = resolveApiBase(privateKey);
  const expiresAt = new Date(Date.now() + LINK_EXPIRATION_MS).toISOString();

  const response = await fetch(`${apiBase}/payment_links`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${privateKey}`,
    },
    body: JSON.stringify({
      name: "Pedido ForMotos",
      description,
      single_use: true,
      collect_shipping: false,
      currency: "COP",
      amount_in_cents: Math.round(amountCop * 100),
      expires_at: expiresAt,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Wompi rechazó la creación del link de pago (status ${response.status}): ${body}`);
  }

  const payload = (await response.json()) as { data: { id: string } };
  return { paymentLinkId: payload.data.id, url: `${CHECKOUT_BASE}/${payload.data.id}` };
}
