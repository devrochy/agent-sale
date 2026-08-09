import { beforeEach, describe, expect, it, vi } from "vitest";

// El SDK se stubea a nivel de módulo: es la primera vez que se testea la
// construcción del payload saliente (hasta ahora `sendMessage.ts` se mockeaba
// entero en los 8 tests de integración, así que esta superficie no tenía
// ninguna red de seguridad).
const create = vi.fn();
const fetchMessage = vi.fn();
const fetchAccount = vi.fn();
const listIncoming = vi.fn();
const twilioFactory = vi.fn();

vi.mock("twilio", () => {
  const factory = (accountSid: string, authToken: string) => {
    twilioFactory(accountSid, authToken);
    if (!accountSid.startsWith("AC")) {
      throw new Error("accountSid must start with AC");
    }
    const messages = Object.assign(
      (sid: string) => ({ fetch: () => fetchMessage(sid) }),
      { create },
    );
    return {
      messages,
      api: { v2010: { accounts: (sid: string) => ({ fetch: () => fetchAccount(sid) }) } },
      incomingPhoneNumbers: { list: listIncoming },
    };
  };
  return { default: factory };
});

const { resetTwilioClientCache, twilioOutboundAdapter } = await import(
  "../../../../../src/gateway/channels/twilio/outbound.js"
);
type ResolvedConnection = Parameters<typeof twilioOutboundAdapter.sendText>[0];

function conexion(overrides: Partial<ResolvedConnection> = {}): ResolvedConnection {
  return {
    id: "conn-1",
    channel: "whatsapp",
    provider: "twilio",
    label: "WhatsApp · Twilio",
    active: true,
    isPrimary: true,
    externalId: "whatsapp:+14155238886",
    displayAddress: "whatsapp:+14155238886",
    updatedAt: new Date("2026-08-08T00:00:00Z"),
    credentials: { accountSid: "ACtest", authToken: "token" },
    ...overrides,
  };
}

beforeEach(() => {
  resetTwilioClientCache();
  create.mockReset().mockResolvedValue({ sid: "SM_ENVIADO" });
  fetchMessage.mockReset().mockResolvedValue({ status: "delivered", errorCode: null });
  fetchAccount.mockReset().mockResolvedValue({ sid: "ACtest" });
  listIncoming.mockReset().mockResolvedValue([{ phoneNumber: "+14155238886" }]);
  twilioFactory.mockReset();
});

describe("twilioOutboundAdapter.sendText", () => {
  it("manda desde el número de la conexión, no de una variable global", async () => {
    const sid = await twilioOutboundAdapter.sendText(
      conexion({ externalId: "whatsapp:+573009999999" }),
      "whatsapp:+573001111111",
      "Hola",
    );

    expect(sid).toBe("SM_ENVIADO");
    expect(create).toHaveBeenCalledWith({
      from: "whatsapp:+573009999999",
      to: "whatsapp:+573001111111",
      body: "Hola",
    });
  });

  it("adjunta mediaUrl como array solo cuando se pasa", async () => {
    await twilioOutboundAdapter.sendText(conexion(), "whatsapp:+57300", "Mira", "https://x.test/a.jpg");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: ["https://x.test/a.jpg"] }),
    );

    create.mockClear();
    await twilioOutboundAdapter.sendText(conexion(), "whatsapp:+57300", "Sin media");
    expect(create.mock.calls[0]![0]).not.toHaveProperty("mediaUrl");
  });

  it("propaga el error si la conexión no tiene credenciales usables", async () => {
    await expect(
      twilioOutboundAdapter.sendText(
        conexion({ credentials: { accountSid: "ACtest" } }),
        "whatsapp:+57300",
        "Hola",
      ),
    ).rejects.toThrow(/accountSid\/authToken/);
  });
});

describe("caché de clientes de Twilio", () => {
  it("reusa el cliente entre envíos de la misma conexión", async () => {
    await twilioOutboundAdapter.sendText(conexion(), "whatsapp:+57300", "Uno");
    await twilioOutboundAdapter.sendText(conexion(), "whatsapp:+57300", "Dos");
    expect(twilioFactory).toHaveBeenCalledTimes(1);
  });

  it("no mezcla cuentas entre conexiones distintas", async () => {
    await twilioOutboundAdapter.sendText(conexion(), "whatsapp:+57300", "Uno");
    await twilioOutboundAdapter.sendText(
      conexion({ id: "conn-2", credentials: { accountSid: "ACotra", authToken: "otro" } }),
      "whatsapp:+57300",
      "Dos",
    );

    expect(twilioFactory).toHaveBeenCalledTimes(2);
    expect(twilioFactory).toHaveBeenNthCalledWith(1, "ACtest", "token");
    expect(twilioFactory).toHaveBeenNthCalledWith(2, "ACotra", "otro");
  });

  it("reconstruye el cliente cuando la credencial se rota (updatedAt cambia)", async () => {
    await twilioOutboundAdapter.sendText(conexion(), "whatsapp:+57300", "Antes");
    await twilioOutboundAdapter.sendText(
      conexion({
        updatedAt: new Date("2026-08-09T00:00:00Z"),
        credentials: { accountSid: "ACtest", authToken: "token-rotado" },
      }),
      "whatsapp:+57300",
      "Después",
    );

    expect(twilioFactory).toHaveBeenCalledTimes(2);
    expect(twilioFactory).toHaveBeenLastCalledWith("ACtest", "token-rotado");
  });
});

describe("twilioOutboundAdapter.getDeliveryStatus", () => {
  it("devuelve estado y errorCode del mensaje", async () => {
    fetchMessage.mockResolvedValue({ status: "failed", errorCode: 63016 });
    await expect(twilioOutboundAdapter.getDeliveryStatus(conexion(), "SM1")).resolves.toEqual({
      status: "failed",
      errorCode: 63016,
    });
    expect(fetchMessage).toHaveBeenCalledWith("SM1");
  });

  it("declara el modelo de entrega por consulta", () => {
    expect(twilioOutboundAdapter.deliveryModel).toBe("poll");
  });
});

describe("twilioOutboundAdapter.verifyCredentials", () => {
  it("valida contra la cuenta sin enviarle un mensaje a nadie", async () => {
    const resultado = await twilioOutboundAdapter.verifyCredentials({
      accountSid: "ACtest",
      authToken: "token",
    });

    expect(fetchAccount).toHaveBeenCalledWith("ACtest");
    expect(create).not.toHaveBeenCalled();
    expect(resultado).toEqual({
      externalId: "whatsapp:+14155238886",
      displayAddress: "whatsapp:+14155238886",
    });
  });

  it("acepta una cuenta de sandbox, que no posee ningún número propio", async () => {
    // Caso real encontrado probando el panel: una cuenta trial usando el
    // sandbox de WhatsApp es válida, pero `incomingPhoneNumbers` viene vacío
    // porque el número del sandbox es compartido de Twilio, no de la cuenta.
    // Devolver null (en vez de lanzar) es lo que deja al caller conservar la
    // dirección ya configurada en vez de rechazar una credencial buena.
    listIncoming.mockResolvedValue([]);

    await expect(
      twilioOutboundAdapter.verifyCredentials({ accountSid: "ACtest", authToken: "token" }),
    ).resolves.toEqual({ externalId: null, displayAddress: null });
    expect(fetchAccount).toHaveBeenCalledWith("ACtest");
  });

  it("no invalida la credencial si no se pueden listar los números", async () => {
    listIncoming.mockRejectedValue(new Error("permisos insuficientes"));

    await expect(
      twilioOutboundAdapter.verifyCredentials({ accountSid: "ACtest", authToken: "token" }),
    ).resolves.toEqual({ externalId: null, displayAddress: null });
  });

  it("propaga el rechazo del proveedor con credenciales inválidas", async () => {
    fetchAccount.mockRejectedValue(new Error("Authenticate"));
    await expect(
      twilioOutboundAdapter.verifyCredentials({ accountSid: "ACtest", authToken: "malo" }),
    ).rejects.toThrow("Authenticate");
  });

  it("rechaza un accountSid con formato inválido antes de llamar a la API", async () => {
    await expect(
      twilioOutboundAdapter.verifyCredentials({ accountSid: "XXmal", authToken: "token" }),
    ).rejects.toThrow(/must start with AC/);
    expect(fetchAccount).not.toHaveBeenCalled();
  });
});
