import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWompiChecksum } from "../../../src/payments/wompiSignature.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

describe("verifyWompiChecksum", () => {
  const data = {
    transaction: { id: "1234-abc", status: "APPROVED", amount_in_cents: 4490000 },
  };
  const properties = ["transaction.id", "transaction.status", "transaction.amount_in_cents"];
  const timestamp = 1610641025;
  const secret = "test_events_abc123";
  const expected = sha256(`1234-abcAPPROVED4490000${timestamp}${secret}`);

  it("acepta un checksum válido", () => {
    expect(verifyWompiChecksum(data, properties, timestamp, expected, secret)).toBe(true);
  });

  it("rechaza un checksum alterado", () => {
    expect(
      verifyWompiChecksum(data, properties, timestamp, `${expected.slice(0, -1)}0`, secret),
    ).toBe(false);
  });

  it("rechaza si el secreto de eventos no coincide", () => {
    expect(verifyWompiChecksum(data, properties, timestamp, expected, "otro_secreto")).toBe(false);
  });

  it("rechaza si los datos reales no coinciden con lo firmado", () => {
    const altered = { transaction: { ...data.transaction, status: "DECLINED" } };
    expect(verifyWompiChecksum(altered, properties, timestamp, expected, secret)).toBe(false);
  });

  it("rechaza si el timestamp no coincide", () => {
    expect(verifyWompiChecksum(data, properties, timestamp + 1, expected, secret)).toBe(false);
  });

  it("resuelve una ruta faltante como string vacío en vez de lanzar", () => {
    const incomplete = { transaction: {} };
    const checksumParaVacio = sha256(`${timestamp}${secret}`);
    expect(
      verifyWompiChecksum(incomplete, properties, timestamp, checksumParaVacio, secret),
    ).toBe(true);
  });
});
