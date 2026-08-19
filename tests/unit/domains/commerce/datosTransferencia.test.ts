import { describe, expect, it } from "vitest";

import { formatearDatosTransferencia } from "../../../../src/domains/commerce/datosTransferencia.js";
import type { TransferAccount } from "../../../../src/shared/db/settingsDirectory.js";

const nequi: TransferAccount = {
  entity: "Nequi",
  accountType: "",
  accountNumber: "3001234567",
  holderName: "ForMotos SAS",
  holderDocument: "900123456-7",
  active: true,
};

const bancolombia: TransferAccount = {
  entity: "Bancolombia",
  accountType: "Ahorros",
  accountNumber: "12345678901",
  holderName: "ForMotos SAS",
  holderDocument: "",
  active: true,
};

describe("formatearDatosTransferencia", () => {
  it("lleva el número de pedido y el monto, que es lo que el cliente copia", () => {
    const texto = formatearDatosTransferencia([nequi], "FM-0042", 250000);
    expect(texto).toContain("FM-0042");
    expect(texto).toContain("$250.000");
    expect(texto).toContain("3001234567");
    expect(texto).toContain("ForMotos SAS");
  });

  it("omite el tipo de cuenta cuando no aplica", () => {
    // Nequi no tiene "Ahorros"/"Corriente": escribir un guion vacío ahí
    // ensucia el mensaje que el cliente lee en el celular.
    expect(formatearDatosTransferencia([nequi], "FM-1", 1000)).toContain("*Nequi*");
    expect(formatearDatosTransferencia([bancolombia], "FM-1", 1000)).toContain(
      "*Bancolombia — Ahorros*",
    );
  });

  it("omite el documento del titular cuando está vacío", () => {
    expect(formatearDatosTransferencia([bancolombia], "FM-1", 1000)).not.toContain("Documento:");
    expect(formatearDatosTransferencia([nequi], "FM-1", 1000)).toContain("Documento: 900123456-7");
  });

  it("lista todas las cuentas separadas, no las mezcla", () => {
    const texto = formatearDatosTransferencia([nequi, bancolombia], "FM-7", 99000);
    expect(texto).toContain("*Nequi*");
    expect(texto).toContain("*Bancolombia — Ahorros*");
    // Dos bloques significa una línea en blanco entre ellos: pegados, un
    // cliente puede leer el titular de una con el número de la otra.
    expect(texto).toMatch(/3001234567[\s\S]*\n\n[\s\S]*12345678901/);
  });

  it("pide el comprobante — es el paso que sigue y nadie lo adivina", () => {
    expect(formatearDatosTransferencia([nequi], "FM-1", 1000)).toContain("comprobante");
  });
});
