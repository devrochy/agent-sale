import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

// scrypt (no bcrypt/argon2 como dependencia nueva — mismo criterio que
// secretBox.ts, que usa AES-GCM nativo de node:crypto en vez de una
// librería de cifrado externa). 64 bytes de salida es más que suficiente
// para una comparación timing-safe sin colisiones prácticas.
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** Formato guardado: "<salt_hex>:<hash_hex>" — mismo criterio de texto plano en una columna `text` que ya usa secretBox.ts, sin padding de base64 que complique el storage. */
export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = (await scryptAsync(plaintext, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

/** Nunca lanza sobre un `stored` malformado — devuelve false, igual que un password incorrecto (no filtra por qué falló). */
export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== KEY_LENGTH) {
    return false;
  }

  const derived = (await scryptAsync(plaintext, salt, KEY_LENGTH)) as Buffer;
  return timingSafeEqual(derived, expected);
}
