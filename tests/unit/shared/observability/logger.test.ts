import { Writable } from "node:stream";
import pino from "pino";
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

  it("censura los campos configurados en redact (PII fuera de logs)", () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    // Mismos paths/censor que src/shared/observability/logger.ts — se
    // prueba el mecanismo de redact contra un stream capturable en vez
    // del stdout real de la instancia compartida.
    const testLogger = pino(
      { redact: { paths: ["customer_phone", "body"], censor: "[REDACTED]" } },
      stream,
    );

    testLogger.info({ customer_phone: "+573000000000", body: "hola", tenant_id: "t1" }, "test");

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.customer_phone).toBe("[REDACTED]");
    expect(parsed.body).toBe("[REDACTED]");
    expect(parsed.tenant_id).toBe("t1");
  });
});
