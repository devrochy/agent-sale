import type { Provider } from "../../shared/db/connectionsDirectory.js";
import { metaInboundAdapter } from "./meta/inbound.js";
import { metaOutboundAdapter } from "./meta/outbound.js";
import { twilioInboundAdapter } from "./twilio/inbound.js";
import { twilioOutboundAdapter } from "./twilio/outbound.js";
import type { InboundAdapter, OutboundAdapter } from "./types.js";

/**
 * Registro de adapters por proveedor. Agregar Meta (Etapa B) es agregar una
 * entrada acá y su implementación del contrato — nada más del gateway tiene
 * que enterarse.
 *
 * El canal (whatsapp/instagram/messenger) no entra en la clave a propósito:
 * vive en la conexión, no en el adapter. Un mismo adapter de Meta atenderá
 * los tres canales, porque Meta los sirve por el mismo webhook y la misma
 * API de envío.
 */

const INBOUND: Partial<Record<Provider, InboundAdapter>> = {
  twilio: twilioInboundAdapter,
  meta: metaInboundAdapter,
};

const OUTBOUND: Partial<Record<Provider, OutboundAdapter>> = {
  twilio: twilioOutboundAdapter,
  meta: metaOutboundAdapter,
};

export function inboundAdapterFor(provider: Provider): InboundAdapter {
  const adapter = INBOUND[provider];
  if (!adapter) {
    throw new Error(`No hay adapter de entrada implementado para el proveedor "${provider}"`);
  }
  return adapter;
}

export function outboundAdapterFor(provider: Provider): OutboundAdapter {
  const adapter = OUTBOUND[provider];
  if (!adapter) {
    throw new Error(`No hay adapter de salida implementado para el proveedor "${provider}"`);
  }
  return adapter;
}

/** Proveedores con adapter de entrada — el webhook solo puede rutear a estos. */
export function inboundProviders(): Provider[] {
  return Object.keys(INBOUND) as Provider[];
}
