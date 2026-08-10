import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import {
  logger,
  REDACT_PATHS,
  sanitizarUrl,
} from "../../../../src/shared/observability/logger.js";

describe("logger", () => {
  it("usa LOG_LEVEL (o \"info\" por defecto) como nivel de la instancia compartida", () => {
    expect(logger.level).toBe(process.env.LOG_LEVEL ?? "info");
  });

  it("un logger hijo incluye los campos de correlación en sus bindings", () => {
    const child = logger.child({ tenant_id: "tenant-1", conversation_id: "conv-1" });

    expect(child.bindings()).toEqual({ tenant_id: "tenant-1", conversation_id: "conv-1" });
  });

  /**
   * Loguea contra un stream capturable usando `REDACT_PATHS`, la lista real de
   * la instancia compartida (que escribe a stdout y no se puede interceptar
   * acá). Importarla en vez de copiarla es deliberado: una copia se
   * desincroniza en silencio, que es justo como se coló `destinatario`.
   */
  function loguearYCapturar(objeto: Record<string, unknown>): Record<string, unknown> {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, stream).info(objeto, "test");
    return JSON.parse(lines[0]!) as Record<string, unknown>;
  }

  it("censura los campos configurados en redact (PII fuera de logs)", () => {
    const parsed = loguearYCapturar({
      customer_phone: "+573000000000",
      body: "hola",
      tenant_id: "t1",
    });

    expect(parsed.customer_phone).toBe("[REDACTED]");
    expect(parsed.body).toBe("[REDACTED]");
    expect(parsed.tenant_id).toBe("t1");
  });

  it("censura `destinatario`, el teléfono del cliente en delivery.rechazado", () => {
    // La clave está en español, así que no la cubrían `to`/`from`: sin esto el
    // número completo salía en claro cada vez que Meta reportaba una entrega
    // fallida.
    const parsed = loguearYCapturar({
      destinatario: "whatsapp:+573184935933",
      error_code: 131047,
    });

    expect(parsed.destinatario).toBe("[REDACTED]");
    expect(parsed.error_code).toBe(131047);
  });
});

describe("sanitizarUrl", () => {
  it("censura el hub.verify_token del handshake de Meta", () => {
    const url = sanitizarUrl(
      "/webhooks/meta?hub.mode=subscribe&hub.challenge=1234&hub.verify_token=secreto-real",
    );

    expect(url).not.toContain("secreto-real");
    expect(url).toContain("hub.verify_token=%5BREDACTED%5D");
    // El resto de la query sobrevive: es lo que permite ver que Meta pegó
    // con `subscribe` y qué challenge mandó.
    expect(url).toContain("hub.mode=subscribe");
    expect(url).toContain("hub.challenge=1234");
  });

  it("censura el token de capacidad del asesor y de la reseña", () => {
    expect(sanitizarUrl("/asesor/tok-abc123")).toBe("/asesor/[REDACTED]");
    expect(sanitizarUrl("/resena/tok-abc123")).toBe("/resena/[REDACTED]");
  });

  it("conserva el sufijo de acción de las rutas del asesor", () => {
    expect(sanitizarUrl("/asesor/tok-abc123/tomar")).toBe("/asesor/[REDACTED]/tomar");
    expect(sanitizarUrl("/asesor/tok-abc123/resolver")).toBe("/asesor/[REDACTED]/resolver");
    expect(sanitizarUrl("/resena/tok-abc123/compartir")).toBe("/resena/[REDACTED]/compartir");
  });

  it("censura el token aunque la ruta traiga query", () => {
    const url = sanitizarUrl("/resena/tok-abc123?estado=ok");

    expect(url).toBe("/resena/[REDACTED]?estado=ok");
  });

  it("deja intactas las URLs sin secretos, byte por byte", () => {
    // Importa que no se re-serialice: una query reordenada o re-codificada
    // en los logs manda a perseguir fantasmas al depurar.
    const url = "/admin/conversaciones?estado=abierta&c=a+b%2Cc";

    expect(sanitizarUrl(url)).toBe(url);
    expect(sanitizarUrl("/webhooks/whatsapp")).toBe("/webhooks/whatsapp");
    expect(sanitizarUrl("/")).toBe("/");
  });

  it("no confunde rutas que solo empiezan parecido", () => {
    expect(sanitizarUrl("/asesores")).toBe("/asesores");
    expect(sanitizarUrl("/admin/asesor/tok-abc123")).toBe("/admin/asesor/tok-abc123");
  });
});
