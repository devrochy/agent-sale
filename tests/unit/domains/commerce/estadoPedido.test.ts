import { describe, expect, it } from "vitest";

import { derivarEstado, ESTADOS_VISIBLES } from "../../../../src/domains/commerce/estadoPedido.js";

describe("derivarEstado", () => {
  it("un pedido abierto se lee por su pago, no por el status", () => {
    // 'abierto' por sí solo no dice nada accionable: lo que interesa es si
    // ya pagó o no.
    expect(derivarEstado("abierto", "pendiente").key).toBe("pendiente_pago");
    expect(derivarEstado("abierto", "pagado").key).toBe("pagado");
  });

  it("el despacho pisa al pago cumplido", () => {
    expect(derivarEstado("despachado", "pagado").key).toBe("despachado");
    // Contraentrega: despachado sin pagar todavía. Sigue siendo despachado
    // — es lo último que pasó.
    expect(derivarEstado("despachado", "pendiente").key).toBe("despachado");
  });

  it("el rechazo pisa al despacho", () => {
    // Un pedido que salió y cuyo pago rebotó es el que hay que mirar
    // primero; verlo como "Despachado" lo escondería.
    expect(derivarEstado("despachado", "rechazado").key).toBe("rechazado");
  });

  it("lo terminal gana sobre lo transitorio", () => {
    // Un pedido cancelado con el pago pendiente ya no espera ningún pago.
    expect(derivarEstado("cancelado", "pendiente").key).toBe("cancelado");
    expect(derivarEstado("expirado", "pendiente").key).toBe("vencido");
    expect(derivarEstado("entregado", "pagado").key).toBe("entregado");
    // Entregado gana incluso sobre un rechazo: si llegó a manos del
    // cliente, el problema de cobro se resuelve por otro lado.
    expect(derivarEstado("entregado", "rechazado").key).toBe("entregado");
  });

  it("cada estado del filtro es alcanzable desde alguna combinación real", () => {
    // Un filtro que nunca devuelve nada es peor que no tenerlo.
    const alcanzables = new Set(
      [
        derivarEstado("abierto", "pendiente"),
        derivarEstado("abierto", "pagado"),
        derivarEstado("despachado", "pagado"),
        derivarEstado("entregado", "pagado"),
        derivarEstado("abierto", "rechazado"),
        derivarEstado("cancelado", "pagado"),
        derivarEstado("expirado", "pendiente"),
      ].map((e) => e.key),
    );
    for (const estado of ESTADOS_VISIBLES) {
      expect(alcanzables.has(estado.key), `${estado.key} no es alcanzable`).toBe(true);
    }
  });

  it("usa solo tonos de chip que existen en el panel", () => {
    const tonos = new Set(["go", "amber", "redline", "violet", "muted"]);
    for (const [status, pago] of [
      ["abierto", "pendiente"],
      ["abierto", "pagado"],
      ["despachado", "pagado"],
      ["entregado", "pagado"],
      ["abierto", "rechazado"],
      ["cancelado", "pagado"],
      ["expirado", "pendiente"],
    ] as const) {
      expect(tonos.has(derivarEstado(status, pago).tone)).toBe(true);
    }
  });
});
