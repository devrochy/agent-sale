import { describe, expect, it } from "vitest";
import { logger } from "../../../../src/shared/observability/logger.js";

describe("logger", () => {
  it("usa LOG_LEVEL (o \"info\" por defecto) como nivel de la instancia compartida", () => {
    expect(logger.level).toBe(process.env.LOG_LEVEL ?? "info");
  });

  it("un logger hijo incluye los campos de correlación en sus bindings", () => {
    const child = logger.child({ tenant_id: "tenant-1", conversation_id: "conv-1" });

    expect(child.bindings()).toEqual({ tenant_id: "tenant-1", conversation_id: "conv-1" });
  });
});
