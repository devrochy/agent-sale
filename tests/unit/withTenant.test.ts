import { describe, expect, it } from "vitest";
import { withTenant } from "../../src/shared/db/withTenant.js";

describe("withTenant", () => {
  it("rechaza un tenantId que no es un UUID sin abrir conexión a la base de datos", async () => {
    await expect(withTenant("not-a-uuid", async () => "unreachable")).rejects.toThrow(
      /tenantId inválido/,
    );
  });
});
