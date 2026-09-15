import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fireConversation (Fase 2 del plan de remediación del incidente
// 2026-09-13, ver ADR-022): reintenta el turno completo — processConversation
// + sendTurnBubbles — antes de darse por vencido y registrar el fallo.
const processConversation = vi.fn();
const sendTurnBubbles = vi.fn();
const recordDebounceFailure = vi.fn();

vi.mock("../../../src/orchestrator/loop.js", () => ({
  processConversation,
  appendInbound: vi.fn(),
}));
vi.mock("../../../src/orchestrator/sendTurnResult.js", () => ({ sendTurnBubbles }));
vi.mock("../../../src/orchestrator/debounceFailures.js", () => ({ recordDebounceFailure }));

const { fireConversation } = await import("../../../src/orchestrator/debounceScheduler.js");

const PAYLOAD = {
  customerExternalId: "+573000000000",
  messageSid: "wamid.test",
  customerName: "Cliente Test",
};

const TURN_RESULT = { stopReason: "end_turn" as const, content: [] };

describe("fireConversation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    processConversation.mockReset();
    sendTurnBubbles.mockReset();
    recordDebounceFailure.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("éxito en el primer intento: no reintenta ni registra fallo", async () => {
    processConversation.mockResolvedValue(TURN_RESULT);
    sendTurnBubbles.mockResolvedValue(undefined);

    await fireConversation("conv-1", PAYLOAD);

    expect(processConversation).toHaveBeenCalledTimes(1);
    expect(sendTurnBubbles).toHaveBeenCalledTimes(1);
    expect(recordDebounceFailure).not.toHaveBeenCalled();
  });

  it("falla una vez y resuelve en el segundo intento: reintenta con backoff y no registra fallo", async () => {
    processConversation
      .mockRejectedValueOnce(new Error("DeepSeek colgado"))
      .mockResolvedValueOnce(TURN_RESULT);
    sendTurnBubbles.mockResolvedValue(undefined);

    const promise = fireConversation("conv-2", PAYLOAD);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(processConversation).toHaveBeenCalledTimes(2);
    expect(sendTurnBubbles).toHaveBeenCalledTimes(1);
    expect(recordDebounceFailure).not.toHaveBeenCalled();
  });

  it("falla las 2 veces: registra el fallo con el error del último intento y no lanza", async () => {
    processConversation.mockRejectedValue(new Error("DeepSeek colgado"));

    const promise = fireConversation("conv-3", PAYLOAD);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBeUndefined();

    expect(processConversation).toHaveBeenCalledTimes(2);
    expect(sendTurnBubbles).not.toHaveBeenCalled();
    expect(recordDebounceFailure).toHaveBeenCalledWith("conv-3", expect.any(Error), 2);
  });

  it("si falla el envío (sendTurnBubbles), reintenta el turno completo, no solo el envío", async () => {
    processConversation.mockResolvedValue(TURN_RESULT);
    sendTurnBubbles.mockRejectedValueOnce(new Error("Meta caída")).mockResolvedValueOnce(undefined);

    const promise = fireConversation("conv-4", PAYLOAD);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(processConversation).toHaveBeenCalledTimes(2);
    expect(sendTurnBubbles).toHaveBeenCalledTimes(2);
    expect(recordDebounceFailure).not.toHaveBeenCalled();
  });

  it("si registrar el fallo en la BD también falla, no lanza (queda solo en el log)", async () => {
    processConversation.mockRejectedValue(new Error("DeepSeek colgado"));
    recordDebounceFailure.mockRejectedValue(new Error("Postgres caído"));

    const promise = fireConversation("conv-5", PAYLOAD);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).resolves.toBeUndefined();
  });
});
