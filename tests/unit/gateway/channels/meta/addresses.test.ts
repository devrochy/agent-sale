import { describe, expect, it } from "vitest";
import {
  canonicalToMetaRecipient,
  metaWaIdToCanonical,
} from "../../../../../src/gateway/channels/meta/addresses.js";

/**
 * El punto más delicado de la Etapa B. Si esta traducción no round-trippea, el
 * mismo humano termina como dos filas de `customers` (una por Twilio, otra por
 * Meta) y se parten historial de pedidos, `bot_paused` y datos de entrega.
 */
describe("traducción de direcciones de Meta", () => {
  it("convierte el wa_id al canónico del sistema", () => {
    expect(metaWaIdToCanonical("573184935933")).toBe("whatsapp:+573184935933");
  });

  it("convierte el canónico al destinatario que espera Meta", () => {
    expect(canonicalToMetaRecipient("whatsapp:+573184935933")).toBe("573184935933");
  });

  it("hace round-trip sin perder ni agregar nada", () => {
    for (const waId of ["573184935933", "5215512345678", "5491112345678", "14155238886"]) {
      expect(canonicalToMetaRecipient(metaWaIdToCanonical(waId))).toBe(waId);
    }
  });

  it("no 'corrige' el wa_id de países donde no coincide con el número marcable", () => {
    // México antepone un 1 y Argentina un 9 en el wa_id. Intentar
    // normalizarlos a un E.164 "real" haría que la respuesta no llegue: hay
    // que devolver exactamente lo que Meta mandó.
    expect(metaWaIdToCanonical("5215512345678")).toBe("whatsapp:+5215512345678");
    expect(canonicalToMetaRecipient("whatsapp:+5491112345678")).toBe("5491112345678");
  });

  it("tolera un wa_id que ya venga con +", () => {
    expect(metaWaIdToCanonical("+573184935933")).toBe("whatsapp:+573184935933");
  });

  it("tolera un canónico sin + (dato viejo)", () => {
    expect(canonicalToMetaRecipient("whatsapp:573184935933")).toBe("573184935933");
  });
});
