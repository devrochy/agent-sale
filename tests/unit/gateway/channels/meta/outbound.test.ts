import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaOutboundAdapter } from "../../../../../src/gateway/channels/meta/outbound.js";

type ResolvedConnection = Parameters<typeof metaOutboundAdapter.sendText>[0];

function conexion(overrides: Partial<ResolvedConnection> = {}): ResolvedConnection {
  return {
    id: "conn-meta",
    channel: "whatsapp",
    provider: "meta",
    label: "WhatsApp · Meta",
    active: true,
    isPrimary: false,
    externalId: "123456789012345",
    displayAddress: "+57 300 123 4567",
    updatedAt: new Date("2026-08-09T00:00:00Z"),
    credentials: { phoneNumberId: "123456789012345", accessToken: "token", appSecret: "s" },
    ...overrides,
  };
}

function respuesta(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("metaOutboundAdapter.sendText", () => {
  it("manda un texto por la Graph API del phone number id de la conexión", async () => {
    fetchMock.mockResolvedValue(respuesta({ messages: [{ id: "wamid.ENVIADO" }] }));

    const id = await metaOutboundAdapter.sendText(conexion(), "whatsapp:+573184935933", "Hola");

    expect(id).toBe("wamid.ENVIADO");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/123456789012345/messages");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer token");
    // El destinatario va en dígitos pelados, no en el canónico del sistema.
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "573184935933",
      type: "text",
      text: { body: "Hola" },
    });
  });

  it("con media manda una imagen con el texto como caption", async () => {
    fetchMock.mockResolvedValue(respuesta({ messages: [{ id: "wamid.IMG" }] }));

    await metaOutboundAdapter.sendText(
      conexion(),
      "whatsapp:+573184935933",
      "Mirá esto",
      "https://x.test/a.jpg",
    );

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({
      type: "image",
      image: { link: "https://x.test/a.jpg", caption: "Mirá esto" },
    });
  });

  it("declara que la entrega se notifica por webhook, no por consulta", () => {
    expect(metaOutboundAdapter.deliveryModel).toBe("webhook");
  });

  it("falla si la conexión no tiene accessToken", async () => {
    await expect(
      metaOutboundAdapter.sendText(
        conexion({ credentials: { phoneNumberId: "1" } }),
        "whatsapp:+57300",
        "Hola",
      ),
    ).rejects.toThrow(/accessToken/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("detecta el error aunque la Graph API responda 200 con un objeto error", async () => {
    // La Graph API no siempre acompaña el error con un status HTTP de error:
    // hay que mirar el body, no solo el código.
    fetchMock.mockResolvedValue(
      respuesta({ error: { message: "Invalid OAuth access token", code: 190 } }, 200),
    );

    await expect(
      metaOutboundAdapter.sendText(conexion(), "whatsapp:+57300", "Hola"),
    ).rejects.toThrow(/Invalid OAuth access token.*190/);
  });

  it("reporta un fallo HTTP con su detalle", async () => {
    fetchMock.mockResolvedValue(respuesta({ error: { message: "Unsupported post request" } }, 400));
    await expect(
      metaOutboundAdapter.sendText(conexion(), "whatsapp:+57300", "Hola"),
    ).rejects.toThrow(/Unsupported post request/);
  });

  it("falla si Meta acepta pero no devuelve id de mensaje", async () => {
    fetchMock.mockResolvedValue(respuesta({ messages: [] }));
    await expect(
      metaOutboundAdapter.sendText(conexion(), "whatsapp:+57300", "Hola"),
    ).rejects.toThrow(/no devolvió un id/);
  });
});

describe("metaOutboundAdapter.verifyCredentials", () => {
  it("lee el propio número sin mandarle un mensaje a nadie", async () => {
    fetchMock.mockResolvedValue(
      respuesta({ display_phone_number: "+57 300 123 4567", verified_name: "ForMotos" }),
    );

    const resultado = await metaOutboundAdapter.verifyCredentials({
      phoneNumberId: "123456789012345",
      accessToken: "token",
    });

    // A diferencia de Twilio, Meta sí puede reportar la dirección — y es
    // distinta de la clave de ruteo, que es el phone number id.
    expect(resultado).toEqual({
      externalId: "123456789012345",
      displayAddress: "+57 300 123 4567",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/123456789012345?fields=display_phone_number");
    expect(init.method).toBeUndefined();
  });

  it("propaga el rechazo de un token inválido", async () => {
    fetchMock.mockResolvedValue(
      respuesta({ error: { message: "Error validating access token", code: 190 } }, 401),
    );

    await expect(
      metaOutboundAdapter.verifyCredentials({ phoneNumberId: "1", accessToken: "malo" }),
    ).rejects.toThrow(/Error validating access token/);
  });

  it("exige el phone number id antes de llamar a la API", async () => {
    await expect(
      metaOutboundAdapter.verifyCredentials({ accessToken: "token" }),
    ).rejects.toThrow(/Phone Number ID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
