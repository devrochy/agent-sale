import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../../../src/admin/auth/passwordHash.js";

describe("passwordHash", () => {
  it("verifica correctamente la contraseña que se hasheó", async () => {
    const password = "correo-horse-batery-staple";
    const hashed = await hashPassword(password);
    expect(await verifyPassword(password, hashed)).toBe(true);
  });

  it("rechaza una contraseña incorrecta", async () => {
    const hashed = await hashPassword("clave-correcta");
    expect(await verifyPassword("clave-incorrecta", hashed)).toBe(false);
  });

  it("produce un hash distinto cada vez (salt aleatorio) pero ambos verifican", async () => {
    const password = "misma-clave-dos-veces";
    const a = await hashPassword(password);
    const b = await hashPassword(password);
    expect(a).not.toBe(b);
    expect(await verifyPassword(password, a)).toBe(true);
    expect(await verifyPassword(password, b)).toBe(true);
  });

  it("guarda el formato salt_hex:hash_hex", async () => {
    const hashed = await hashPassword("hola");
    const parts = hashed.split(":");
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => /^[0-9a-f]+$/.test(p))).toBe(true);
  });

  it("rechaza un formato inválido sin lanzar", async () => {
    await expect(verifyPassword("cualquier-cosa", "no-tiene-el-formato-esperado")).resolves.toBe(
      false,
    );
  });
});
