import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendToConversation = vi.fn();
const splitForBubbles = vi.fn();

vi.mock("../../../src/gateway/sendMessage.js", () => ({
  sendToConversation: (...args: unknown[]) => sendToConversation(...args),
}));
vi.mock("../../../src/gateway/messageSplitter.js", () => ({
  splitForBubbles: (...args: unknown[]) => splitForBubbles(...args),
}));
vi.mock("../../../src/shared/db/settingsDirectory.js", () => ({
  getBehaviorConfig: async () => null,
}));

const { sendTurnBubbles } = await import("../../../src/orchestrator/sendTurnResult.js");

interface LogCall {
  fields: Record<string, unknown>;
  msg: string;
}

function fakeLogger() {
  const calls: { level: string; call: LogCall }[] = [];
  const capture = (level: string) => (fields: Record<string, unknown>, msg: string) => {
    calls.push({ level, call: { fields, msg } });
  };
  const logger = {
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
  } as unknown as Logger;
  return {
    logger,
    events: () => calls.map((c) => c.call.fields.event),
    find: (event: string) => calls.find((c) => c.call.fields.event === event),
  };
}

beforeEach(() => {
  sendToConversation.mockReset();
  splitForBubbles.mockReset();
});

describe("sendTurnBubbles — el resultado del envío se reporta como fue", () => {
  it("confirma el envío solo cuando todas las burbujas salieron", async () => {
    splitForBubbles.mockReturnValue(["hola"]);
    sendToConversation.mockResolvedValue("SM1");
    const log = fakeLogger();

    await sendTurnBubbles("conv-1", { responseText: "hola", mediaUrl: null }, log.logger);

    expect(log.find("gateway.confirmacion_envio")).toBeDefined();
    expect(log.find("gateway.envio_incompleto")).toBeUndefined();
  });

  it("NO confirma el envío si se perdieron todas las burbujas", async () => {
    // Este es el caso que se vio en la validación manual de la Etapa C1: sin
    // conexión para el canal fallaban los dos intentos de cada burbuja y el
    // turno igual terminaba con "Mensaje enviado y confirmado por el
    // proveedor del canal", que en Grafana se lee como entrega exitosa.
    splitForBubbles.mockReturnValue(["hola"]);
    sendToConversation.mockRejectedValue(new Error("No hay una conexión primary"));
    const log = fakeLogger();

    await sendTurnBubbles("conv-1", { responseText: "hola", mediaUrl: null }, log.logger);

    expect(log.find("gateway.confirmacion_envio")).toBeUndefined();
    const incompleto = log.find("gateway.envio_incompleto");
    expect(incompleto?.call.fields).toMatchObject({ bubble_count: 1, bubbles_lost: 1 });
  });

  it("tampoco confirma si solo se perdió una burbuja de varias", async () => {
    // La entrega parcial es el caso peligroso: el cliente recibe media
    // respuesta, así que un log de éxito acá es peor que ninguno.
    splitForBubbles.mockReturnValue(["primera", "segunda"]);
    sendToConversation
      .mockResolvedValueOnce("SM1")
      .mockRejectedValue(new Error("timeout del proveedor"));
    const log = fakeLogger();

    await sendTurnBubbles("conv-1", { responseText: "primera segunda", mediaUrl: null }, log.logger);

    expect(log.find("gateway.confirmacion_envio")).toBeUndefined();
    expect(log.find("gateway.envio_incompleto")?.call.fields).toMatchObject({
      bubble_count: 2,
      bubbles_lost: 1,
    });
  });

  it("una burbuja que sale en el reintento no marca el turno como incompleto", async () => {
    splitForBubbles.mockReturnValue(["hola"]);
    sendToConversation.mockRejectedValueOnce(new Error("hipo de red")).mockResolvedValue("SM1");
    const log = fakeLogger();

    await sendTurnBubbles("conv-1", { responseText: "hola", mediaUrl: null }, log.logger);

    expect(log.find("gateway.envio_burbuja_fallido")).toBeDefined();
    expect(log.find("gateway.confirmacion_envio")).toBeDefined();
    expect(log.find("gateway.envio_incompleto")).toBeUndefined();
  });

  it("el error va bajo la clave `err`, que es la que pino serializa", async () => {
    // Con cualquier otro nombre de campo un Error se loguea como `{}` y no
    // queda registro de por qué falló el envío.
    splitForBubbles.mockReturnValue(["hola"]);
    const causa = new Error("No hay una conexión primary configurada");
    sendToConversation.mockRejectedValue(causa);
    const log = fakeLogger();

    await sendTurnBubbles("conv-1", { responseText: "hola", mediaUrl: null }, log.logger);

    expect(log.find("gateway.envio_burbuja_fallido")?.call.fields.err).toBe(causa);
    expect(log.find("gateway.envio_burbuja_perdido")?.call.fields.err).toBe(causa);
  });

  it("una conversación ya escalada no envía nada ni confirma nada", async () => {
    const log = fakeLogger();

    await sendTurnBubbles("conv-1", { responseText: null, mediaUrl: null }, log.logger);

    expect(sendToConversation).not.toHaveBeenCalled();
    expect(log.events()).toEqual(["orchestrator.conversacion_escalada"]);
  });
});
