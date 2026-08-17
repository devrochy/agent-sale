import twilio from "twilio";
import type { ConnectionCredentials, ResolvedConnection } from "../../../shared/db/connectionsDirectory.js";
import type {
  MessageDeliveryStatus,
  PollingOutboundAdapter,
  VerifiedCredentials,
} from "../types.js";

/**
 * Adapter de salida de Twilio. Reemplaza el acoplamiento de
 * `src/gateway/sendMessage.ts` a `env.twilioAccountSid`/`authToken`/
 * `twilioWhatsappNumber`: ahora todo sale de la conexión.
 */

/**
 * El cliente se cachea por conexión **y por `updatedAt`**. El caché anterior
 * (`client ??= twilio(...)` a nivel de módulo, sin clave) se volvió incorrecto
 * al haber más de una conexión: dos cuentas distintas habrían mandado ambas
 * desde la primera, y una credencial rotada desde el panel habría seguido
 * usando el token viejo hasta reiniciar el proceso.
 */
const clients = new Map<string, { client: twilio.Twilio; updatedAt: number }>();

function getClient(connection: ResolvedConnection): twilio.Twilio {
  const updatedAt = connection.updatedAt.getTime();
  const cached = clients.get(connection.id);
  if (cached && cached.updatedAt === updatedAt) {
    return cached.client;
  }
  const client = buildClient(connection.credentials);
  clients.set(connection.id, { client, updatedAt });
  return client;
}

function buildClient(credentials: ConnectionCredentials): twilio.Twilio {
  const { accountSid, authToken } = credentials;
  if (!accountSid || !authToken) {
    throw new Error("La conexión de Twilio no tiene accountSid/authToken configurados");
  }
  // El constructor valida que el SID empiece con "AC" y lanza si no — por eso
  // nunca se construye al importar el módulo.
  return twilio(accountSid, authToken);
}

export const twilioOutboundAdapter: PollingOutboundAdapter = {
  provider: "twilio",
  deliveryModel: "poll",

  /**
   * Que esta llamada no lance solo confirma que Twilio *aceptó* el mensaje
   * para entregarlo, no que llegó al teléfono. La entrega real (o el rechazo,
   * ej. el 63016 de "fuera de la ventana de 24h") se resuelve después, de
   * forma asíncrona — ver getDeliveryStatus y src/jobs/verifyDelivery.ts.
   */
  async sendText(
    connection: ResolvedConnection,
    to: string,
    text: string,
    mediaUrl?: string,
  ): Promise<string> {
    const message = await getClient(connection).messages.create({
      from: connection.externalId,
      to,
      body: text,
      ...(mediaUrl ? { mediaUrl: [mediaUrl] } : {}),
    });
    return message.sid;
  },

  async getDeliveryStatus(
    connection: ResolvedConnection,
    messageId: string,
  ): Promise<MessageDeliveryStatus> {
    const message = await getClient(connection).messages(messageId).fetch();
    return { status: message.status, errorCode: message.errorCode };
  },

  /**
   * Valida SID y token juntos con la llamada más barata posible: leer la
   * propia cuenta. No cuesta dinero y, sobre todo, **no le manda un mensaje de
   * prueba a nadie**. Es lo único que decide si las credenciales sirven.
   *
   * Aparte, *intenta* deducir el número de envío para ahorrarle al admin
   * tipear la clave de ruteo (tipearla mal da una conexión que guarda bien
   * pero cuyo webhook no matchea nunca). Es un intento, no un requisito: una
   * cuenta que usa el **sandbox de WhatsApp** no posee ningún número propio
   * —el sandbox es un número compartido de Twilio— así que
   * `incomingPhoneNumbers` viene vacío aunque la credencial sea perfectamente
   * válida. Devolver `null` deja que el caller conserve la dirección que ya
   * tenía configurada, en vez de rechazar una credencial buena.
   */
  async verifyCredentials(credentials: ConnectionCredentials): Promise<VerifiedCredentials> {
    const client = buildClient(credentials);
    await client.api.v2010.accounts(credentials.accountSid!).fetch();

    let numero: string | undefined;
    try {
      const senders = await client.incomingPhoneNumbers.list({ limit: 1 });
      numero = senders[0]?.phoneNumber;
    } catch {
      // Que no se pueda listar (permisos de subcuenta, por ejemplo) tampoco
      // invalida la credencial: la cuenta ya respondió arriba.
      numero = undefined;
    }

    const externalId = numero ? `whatsapp:${numero}` : null;
    return { externalId, displayAddress: externalId };
  },
};

/** Solo para tests: descarta los clientes cacheados entre casos. */
export function resetTwilioClientCache(): void {
  clients.clear();
}
