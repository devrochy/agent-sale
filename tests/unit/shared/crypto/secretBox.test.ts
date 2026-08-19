import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../../../../src/shared/crypto/secretBox.js";

describe("secretBox", () => {
  it("desencripta exactamente el texto que se cifró", () => {
    const plaintext = "sk-ant-api03-esto-es-una-key-de-prueba";
    const encrypted = encryptSecret(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it("produce un texto cifrado distinto cada vez (IV aleatorio)", () => {
    const plaintext = "misma-key-dos-veces";
    const a = encryptSecret(plaintext);
    const b = encryptSecret(plaintext);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(plaintext);
    expect(decryptSecret(b)).toBe(plaintext);
  });

  it("guarda el formato iv:authTag:ciphertext en hex", () => {
    const encrypted = encryptSecret("hola");
    const parts = encrypted.split(":");
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => /^[0-9a-f]+$/.test(p))).toBe(true);
  });

  it("rechaza un texto cifrado manipulado (auth tag no coincide)", () => {
    const encrypted = encryptSecret("valor-secreto");
    const [iv, authTag, ciphertext] = encrypted.split(":");
    // Altera un byte del ciphertext — GCM debe detectarlo y lanzar, no
    // devolver texto corrupto silenciosamente.
    //
    // El byte nuevo se elige distinto del que había: escribir "00" fijo
    // hacía que el test fallara ~1 de cada 256 corridas, cuando el
    // ciphertext ya terminaba en "00" y por lo tanto no se alteraba nada.
    const ultimoByte = ciphertext!.slice(-2);
    const tampered = `${iv}:${authTag}:${ciphertext!.slice(0, -2)}${ultimoByte === "00" ? "ff" : "00"}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rechaza un formato inválido (no tiene 3 partes)", () => {
    expect(() => decryptSecret("no-es-un-formato-valido")).toThrow(/formato/i);
  });
});
