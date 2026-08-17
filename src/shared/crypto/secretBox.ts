import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";

// Cifrado en reposo para credenciales que un tenant trae propias (BYOK,
// Fase 11.4 — ver docs/fase-11-panel-admin-dashboard/adrs/
// ADR-020-proveedor-modelo-configurable-byok.md). AES-256-GCM: además de
// confidencialidad, el auth tag detecta si el texto cifrado fue alterado
// (decryptSecret lanza en vez de devolver basura silenciosa).
const ALGORITHM = "aes-256-gcm";
// 12 bytes es el tamaño de IV recomendado para GCM (NIST SP 800-38D) — un
// IV más largo no rompe nada, pero no aporta seguridad extra y complica
// el formato de guardado sin necesidad.
const IV_LENGTH = 12;

function getKey(): Buffer {
  const key = Buffer.from(env.tenantSecretsEncryptionKey, "base64");
  if (key.length !== 32) {
    throw new Error(
      "TENANT_SECRETS_ENCRYPTION_KEY debe decodificar a exactamente 32 bytes (AES-256) en base64",
    );
  }
  return key;
}

/** Formato guardado: "<iv_hex>:<authTag_hex>:<ciphertext_hex>" — texto, sin padding de base64 que complique el storage en una columna `text`. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(encrypted: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error("Formato de secreto cifrado inválido (se esperaba iv:authTag:ciphertext)");
  }
  const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
