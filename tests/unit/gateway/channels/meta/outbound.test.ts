import { createHmac } from "node:crypto";
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
    }, "whatsapp");

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
      metaOutboundAdapter.verifyCredentials({ phoneNumberId: "1", accessToken: "malo" }, "whatsapp"),
    ).rejects.toThrow(/Error validating access token/);
  });

  it("exige el phone number id antes de llamar a la API", async () => {
    await expect(
      metaOutboundAdapter.verifyCredentials({ accessToken: "token" }, "whatsapp"),
    ).rejects.toThrow(/Phone Number ID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("manda appsecret_proof para que Meta valide también el App Secret", async () => {
    // Sin esto un App Secret mal pegado se guardaba como válido y el síntoma
    // aparecía después: cada webhook entrante fallando la firma.
    fetchMock.mockResolvedValue(respuesta({ display_phone_number: "+57 300 123 4567" }));

    await metaOutboundAdapter.verifyCredentials({
      phoneNumberId: "123456789012345",
      accessToken: "token",
      appSecret: "el-secreto",
    }, "whatsapp");

    const esperado = createHmac("sha256", "el-secreto").update("token").digest("hex");
    expect(fetchMock.mock.calls[0]![0]).toContain(`appsecret_proof=${esperado}`);
  });

  it("no manda appsecret_proof si la conexión todavía no tiene App Secret", async () => {
    fetchMock.mockResolvedValue(respuesta({ display_phone_number: "+57 300 123 4567" }));

    await metaOutboundAdapter.verifyCredentials({
      phoneNumberId: "123456789012345",
      accessToken: "token",
    }, "whatsapp");

    expect(fetchMock.mock.calls[0]![0]).not.toContain("appsecret_proof");
  });

  it("propaga el rechazo de un App Secret incorrecto", async () => {
    fetchMock.mockResolvedValue(
      respuesta({ error: { message: "Invalid appsecret_proof provided", code: 190 } }, 400),
    );

    await expect(
      metaOutboundAdapter.verifyCredentials({
        phoneNumberId: "123456789012345",
        accessToken: "token",
        appSecret: "secreto-equivocado",
      }, "whatsapp"),
    ).rejects.toThrow(/appsecret_proof/);
  });
});

// ---------------------------------------------------------------------------
// Instagram Direct (Fase 19, Etapa C2). Mismo proveedor y mismo host, pero
// otra API: endpoint, cuerpo y campo del id devuelto son distintos.
// ---------------------------------------------------------------------------

const IGSID = "6789012345678901";

function conexionInstagram(): ResolvedConnection {
  return conexion({
    id: "conn-ig",
    channel: "instagram",
    label: "Instagram · Meta",
    externalId: "17841400000000001",
    displayAddress: "@formotos",
    credentials: { accessToken: "token-de-pagina", appSecret: "s" },
  });
}

describe("metaOutboundAdapter.sendText — Instagram (Etapa C2)", () => {
  it("manda el DM a /me/messages con recipient.id, no a /{id}/messages con `to`", async () => {
    fetchMock.mockResolvedValue(respuesta({ recipient_id: IGSID, message_id: "mid.ENVIADO" }));

    const id = await metaOutboundAdapter.sendText(conexionInstagram(), IGSID, "Hola");

    expect(id).toBe("mid.ENVIADO");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/me/messages");
    expect(url).not.toContain("17841400000000001");
    expect(init.headers.Authorization).toBe("Bearer token-de-pagina");
    expect(JSON.parse(init.body)).toEqual({
      recipient: { id: IGSID },
      message: { text: "Hola" },
    });
  });

  it("el IGSID va verbatim: no se le aplica la traducción de WhatsApp", async () => {
    fetchMock.mockResolvedValue(respuesta({ message_id: "mid.1" }));
    await metaOutboundAdapter.sendText(conexionInstagram(), IGSID, "Hola");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).recipient.id).toBe(IGSID);
  });

  it("con media manda DOS mensajes: Instagram no admite texto y adjunto juntos", async () => {
    fetchMock
      .mockResolvedValueOnce(respuesta({ message_id: "mid.IMG" }))
      .mockResolvedValueOnce(respuesta({ message_id: "mid.TEXTO" }));

    const id = await metaOutboundAdapter.sendText(
      conexionInstagram(),
      IGSID,
      "Mirá este casco",
      "https://ejemplo.test/casco.jpg",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).message).toEqual({
      attachment: { type: "image", payload: { url: "https://ejemplo.test/casco.jpg" } },
    });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).message).toEqual({
      text: "Mirá este casco",
    });
    // Se devuelve el id del texto, que es el mensaje que lleva la respuesta.
    expect(id).toBe("mid.TEXTO");
  });

  it("lanza si Instagram acepta pero no devuelve message_id", async () => {
    fetchMock.mockResolvedValue(respuesta({ recipient_id: IGSID }));
    await expect(
      metaOutboundAdapter.sendText(conexionInstagram(), IGSID, "Hola"),
    ).rejects.toThrow(/no devolvió un id/);
  });

  it("propaga el error de la Graph API", async () => {
    fetchMock.mockResolvedValue(
      respuesta({ error: { message: "Fuera de la ventana de mensajería", code: 10 } }, 400),
    );
    await expect(
      metaOutboundAdapter.sendText(conexionInstagram(), IGSID, "Hola"),
    ).rejects.toThrow(/Instagram rechazó el envío.*ventana/);
  });
});

describe("metaOutboundAdapter.verifyCredentials — Instagram (Etapa C2)", () => {
  it("deduce el IGID y el usuario desde la Página, sin mandarle un mensaje a nadie", async () => {
    fetchMock.mockResolvedValue(
      respuesta({ instagram_business_account: { id: "17841400000000001", username: "formotos" } }),
    );

    const resultado = await metaOutboundAdapter.verifyCredentials(
      { accessToken: "token-de-pagina", appSecret: "secreto" },
      "instagram",
    );

    // El IGID es la clave de ruteo del webhook: tiene que salir del proveedor,
    // porque no es un dato que el admin tenga a mano para tipear.
    expect(resultado).toEqual({ externalId: "17841400000000001", displayAddress: "@formotos" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/me?");
    expect(url).toContain("instagram_business_account");
    expect(init.method).toBeUndefined();
  });

  it("manda appsecret_proof para validar también el App Secret", async () => {
    fetchMock.mockResolvedValue(
      respuesta({ instagram_business_account: { id: "1", username: "x" } }),
    );
    await metaOutboundAdapter.verifyCredentials(
      { accessToken: "token-de-pagina", appSecret: "secreto" },
      "instagram",
    );
    const esperado = createHmac("sha256", "secreto").update("token-de-pagina").digest("hex");
    expect(fetchMock.mock.calls[0]![0]).toContain(`appsecret_proof=${esperado}`);
  });

  it("rechaza con un mensaje accionable si la Página no tiene Instagram vinculado", async () => {
    // Es el error de configuración más común y el que peor se diagnostica: el
    // token es válido, así que sin este chequeo la conexión se guardaría bien
    // y no llegaría nunca un mensaje.
    fetchMock.mockResolvedValue(respuesta({ id: "pagina-sin-instagram" }));
    await expect(
      metaOutboundAdapter.verifyCredentials({ accessToken: "t", appSecret: "s" }, "instagram"),
    ).rejects.toThrow(/no tiene una cuenta de Instagram vinculada/);
  });

  it("no pide Phone Number ID para Instagram", async () => {
    fetchMock.mockResolvedValue(
      respuesta({ instagram_business_account: { id: "1", username: "x" } }),
    );
    await expect(
      metaOutboundAdapter.verifyCredentials({ accessToken: "t", appSecret: "s" }, "instagram"),
    ).resolves.toBeDefined();
  });
});
