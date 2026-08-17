import { env } from "../../config/env.js";
import { decryptSecret, encryptSecret } from "../crypto/secretBox.js";
import { logger } from "../observability/logger.js";
import { pool } from "./pool.js";
import { withTransaction } from "./withTransaction.js";

/**
 * Único punto que consulta `channel_connections` directamente (mismo
 * criterio que settingsDirectory.ts para `settings`). Es la matriz canal x
 * proveedor de la Fase 19: un mismo canal puede tener más de un proveedor
 * activo a la vez, y cada conversación recuerda por cuál entró.
 *
 * La tabla la crea `migrations/0053_channel_connections.cjs`; la fila de
 * Twilio la siembra `ensureConnectionsFromEnv()` al arrancar, no la
 * migración (ver el comentario de esa migración para el porqué).
 */

export type Channel = "whatsapp" | "instagram" | "messenger";
export type Provider = "twilio" | "meta";

/**
 * Credenciales ya descifradas. Forma libre a propósito: cada proveedor tiene
 * campos distintos (Twilio `accountSid`/`authToken`, Meta necesitará
 * `appSecret`/`accessToken`/`verifyToken`) y se guardan como un único blob
 * JSON cifrado para que agregar un proveedor no requiera migrar el esquema.
 */
export type ConnectionCredentials = Record<string, string>;

/** Conexión sin secretos — lo que lista el panel y lo que es seguro loguear. */
export interface ConnectionSummary {
  id: string;
  channel: Channel;
  provider: Provider;
  label: string;
  active: boolean;
  isPrimary: boolean;
  /** Clave de ruteo entrante: para Twilio el campo `To`, para Meta el `phone_number_id`. */
  externalId: string;
  /** Lo que se muestra en el panel — para Meta no coincide con `externalId`. */
  displayAddress: string | null;
  updatedAt: Date;
}

/** Conexión con credenciales usables. Solo la consume la capa de adapters. */
export interface ResolvedConnection extends ConnectionSummary {
  credentials: ConnectionCredentials;
}

interface ConnectionRow {
  id: string;
  channel: Channel;
  provider: Provider;
  label: string;
  active: boolean;
  is_primary: boolean;
  external_id: string;
  display_address: string | null;
  credentials_encrypted: string;
  updated_at: Date;
}

const COLUMNS =
  "id, channel, provider, label, active, is_primary, external_id, display_address, credentials_encrypted, updated_at";

/**
 * Caché en proceso. Sin esto, cada POST a `/webhooks/whatsapp` (ruta pública)
 * haría una query a Postgres más un descifrado AES-GCM *antes* de poder
 * rechazar basura — un amplificador de DoS. El TTL es corto y además se
 * invalida explícitamente en cada escritura, así que rotar una credencial
 * desde el panel se refleja sin reiniciar el proceso.
 */
const CACHE_TTL_MS = 30_000;
let cache: { rows: ResolvedConnection[]; expiresAt: number } | null = null;

export function invalidateConnectionsCache(): void {
  cache = null;
}

/**
 * Credenciales de Twilio tomadas de las variables de entorno — fallback de
 * la conexión sembrada desde env mientras dure la transición a credenciales
 * en base de datos. Sin este fallback, perder
 * `TENANT_SECRETS_ENCRYPTION_KEY` pasaría de ser una degradación (key del
 * LLM y Wompi) a un apagón total de WhatsApp.
 */
function twilioCredentialsFromEnv(): ConnectionCredentials | null {
  if (!env.twilioAccountSid || !env.twilioAuthToken) {
    return null;
  }
  return { accountSid: env.twilioAccountSid, authToken: env.twilioAuthToken };
}

/**
 * Falla suave a propósito: una credencial que no descifra no debe lanzar
 * dentro del request de un webhook. Se loguea fuerte y la conexión queda
 * fuera de la lista, con lo que el webhook responde 200 sin encolar en vez
 * de reventar (y el proveedor no reintenta para siempre).
 */
function resolveCredentials(row: ConnectionRow): ConnectionCredentials | null {
  try {
    return JSON.parse(decryptSecret(row.credentials_encrypted)) as ConnectionCredentials;
  } catch (error) {
    const fallback = row.provider === "twilio" ? twilioCredentialsFromEnv() : null;
    logger.error(
      { error, connection_id: row.id, provider: row.provider, usando_fallback_env: fallback !== null },
      "No se pudieron descifrar las credenciales de la conexión",
    );
    return fallback;
  }
}

function mapRow(row: ConnectionRow): ResolvedConnection | null {
  const credentials = resolveCredentials(row);
  if (!credentials) {
    return null;
  }
  return {
    id: row.id,
    channel: row.channel,
    provider: row.provider,
    label: row.label,
    active: row.active,
    isPrimary: row.is_primary,
    externalId: row.external_id,
    displayAddress: row.display_address,
    updatedAt: row.updated_at,
    credentials,
  };
}

async function loadAll(): Promise<ResolvedConnection[]> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.rows;
  }
  const result = await pool.query<ConnectionRow>(
    `SELECT ${COLUMNS} FROM channel_connections ORDER BY created_at`,
  );
  const rows = result.rows
    .map(mapRow)
    .filter((row): row is ResolvedConnection => row !== null);
  cache = { rows, expiresAt: Date.now() + CACHE_TTL_MS };
  return rows;
}

function withoutCredentials({ credentials: _credentials, ...summary }: ResolvedConnection): ConnectionSummary {
  return summary;
}

/** Para el panel: nunca devuelve secretos, ni siquiera enmascarados. */
export async function listConnections(): Promise<ConnectionSummary[]> {
  return (await loadAll()).map(withoutCredentials);
}

export async function getConnection(id: string): Promise<ResolvedConnection | null> {
  return (await loadAll()).find((connection) => connection.id === id) ?? null;
}

/**
 * Conexiones de un proveedor **con sus credenciales**. Existe para el
 * handshake de verificación de Meta, que llega sin identificar a qué conexión
 * corresponde: hay que comparar su `verifyToken` contra las que haya. No usar
 * para listar en el panel — para eso está `listConnections`, que no expone
 * secretos.
 */
export async function listConnectionsWithCredentials(
  provider: Provider,
): Promise<ResolvedConnection[]> {
  return (await loadAll()).filter((connection) => connection.provider === provider);
}

/**
 * La conexión que se usa cuando no hay conversación de por medio (ej.
 * notificaciones a administradores). Una sola por canal, garantizada por el
 * índice único parcial de la migración 0053 — no por convención.
 */
export async function getPrimaryConnection(channel: Channel): Promise<ResolvedConnection | null> {
  return (await loadAll()).find((c) => c.channel === channel && c.isPrimary) ?? null;
}

/**
 * Resuelve la conexión a la que apunta un webhook entrante, a partir de la
 * clave de ruteo que trae el payload (todavía sin verificar la firma: por eso
 * el resultado solo sirve para *buscar* la credencial, no para confiar en el
 * request).
 */
export async function findConnectionByExternalId(
  provider: Provider,
  externalId: string,
): Promise<ResolvedConnection | null> {
  return (
    (await loadAll()).find((c) => c.provider === provider && c.externalId === externalId) ?? null
  );
}

export interface SaveConnectionInput {
  channel: Channel;
  provider: Provider;
  label: string;
  externalId: string;
  displayAddress: string | null;
  credentials: ConnectionCredentials;
}

/**
 * Alta o actualización por clave de ruteo. Llamar solo después de validar las
 * credenciales con una llamada real al proveedor (ver "Probar y guardar" en
 * adminPanel.ts), nunca antes — mismo criterio que `saveWompiConfig`.
 */
export async function saveConnection(input: SaveConnectionInput): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO channel_connections (channel, provider, label, external_id, display_address, credentials_encrypted)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (provider, external_id) DO UPDATE SET
       channel = EXCLUDED.channel,
       label = EXCLUDED.label,
       display_address = EXCLUDED.display_address,
       credentials_encrypted = EXCLUDED.credentials_encrypted,
       updated_at = now()
     RETURNING id`,
    [
      input.channel,
      input.provider,
      input.label,
      input.externalId,
      input.displayAddress,
      encryptSecret(JSON.stringify(input.credentials)),
    ],
  );
  invalidateConnectionsCache();
  // Un canal sin primary deja `sendToPrimary` lanzando y con él todas las
  // notificaciones a administradores. Pasa de verdad en un despliegue solo-Meta:
  // `ensureConnectionsFromEnv` corta antes de llegar a `asegurarPrimary` cuando
  // no hay credenciales de Twilio en el entorno, y la fila nace `is_primary
  // false`. Acá cubre todos los caminos de alta, no solo el de la semilla.
  await asegurarPrimary(input.channel);
  return result.rows[0]!.id;
}

/**
 * Actualización de una conexión **por id**, no por clave de ruteo. Existe
 * porque el panel deja editar la clave de ruteo misma (el phone number id de
 * Meta): con `saveConnection` un id nuevo no colisiona con nada, así que
 * insertaría una segunda conexión y dejaría la vieja activa y con las
 * credenciales de antes — el admin ve "guardado" y las respuestas siguen
 * saliendo por el número anterior.
 *
 * Devuelve `false` si la clave de ruteo ya pertenece a otra conexión del mismo
 * proveedor: es un choque legítimo que el panel tiene que explicar, no un error.
 */
export async function updateConnection(
  id: string,
  input: Omit<SaveConnectionInput, "channel" | "provider">,
): Promise<boolean> {
  try {
    await pool.query(
      `UPDATE channel_connections SET
         label = $2,
         external_id = $3,
         display_address = $4,
         credentials_encrypted = $5,
         updated_at = now()
       WHERE id = $1`,
      [
        id,
        input.label,
        input.externalId,
        input.displayAddress,
        encryptSecret(JSON.stringify(input.credentials)),
      ],
    );
  } catch (error) {
    // 23505 = unique_violation sobre (provider, external_id).
    if ((error as { code?: string }).code === "23505") {
      return false;
    }
    throw error;
  }
  invalidateConnectionsCache();
  return true;
}

export async function setConnectionActive(id: string, active: boolean): Promise<void> {
  await pool.query("UPDATE channel_connections SET active = $1, updated_at = now() WHERE id = $2", [
    active,
    id,
  ]);
  invalidateConnectionsCache();
}

/**
 * Mueve la marca de primary dentro de un canal. En una transacción porque el
 * índice único parcial rechazaría el estado intermedio de dos primarys.
 */
export async function setPrimaryConnection(id: string): Promise<void> {
  await withTransaction(async (client) => {
    const target = await client.query<{ channel: Channel }>(
      "SELECT channel FROM channel_connections WHERE id = $1",
      [id],
    );
    const channel = target.rows[0]?.channel;
    if (!channel) {
      throw new Error(`No existe la conexión ${id}`);
    }
    await client.query(
      "UPDATE channel_connections SET is_primary = false, updated_at = now() WHERE channel = $1 AND is_primary",
      [channel],
    );
    await client.query(
      "UPDATE channel_connections SET is_primary = true, updated_at = now() WHERE id = $1",
      [id],
    );
  });
  invalidateConnectionsCache();
}

/**
 * Siembra la conexión de Twilio desde las variables de entorno si todavía no
 * existe. Idempotente (`ON CONFLICT DO NOTHING`), pensada para llamarse en
 * cada arranque: cubre producción, desarrollo local y CI con un solo camino
 * de código, y no pisa nunca lo que un admin haya editado desde el panel.
 *
 * Deliberadamente fuera de la migración: node-pg-migrate corre con otro rol y
 * puede no tener los secretos, y cifrar desde un `.cjs` obligaría a duplicar
 * el formato de secretBox.ts.
 */
export async function ensureConnectionsFromEnv(): Promise<void> {
  const credentials = twilioCredentialsFromEnv();
  if (!credentials || !env.twilioWhatsappNumber) {
    logger.info(
      { event: "conexiones.sin_semilla_env" },
      "Sin credenciales de Twilio en el entorno: no se siembra conexión de WhatsApp",
    );
    return;
  }

  const result = await pool.query<{ id: string }>(
    `INSERT INTO channel_connections
       (channel, provider, label, active, is_primary, external_id, display_address, credentials_encrypted)
     VALUES ('whatsapp', 'twilio', 'WhatsApp · Twilio', true, true, $1, $1, $2)
     ON CONFLICT (provider, external_id) DO NOTHING
     RETURNING id`,
    [env.twilioWhatsappNumber, encryptSecret(JSON.stringify(credentials))],
  );

  if (result.rows[0]) {
    logger.info(
      { event: "conexiones.semilla_creada", connection_id: result.rows[0].id },
      "Conexión de WhatsApp/Twilio sembrada desde el entorno",
    );
  }
  invalidateConnectionsCache();
  await asegurarPrimary("whatsapp");
  await backfillConversationsSinConexion();
}

/**
 * Garantiza que el canal tenga una conexión primary si tiene alguna conexión.
 * Quedarse sin primary no es hipotético: basta con borrar o reasignar la que
 * la tenía, y el índice único parcial no obliga a que exista *alguna*. El
 * efecto sería silencioso y feo — `sendToPrimary` lanza, y con él todas las
 * notificaciones a administradores (reporte diario, aviso de pago,
 * escalamiento), que son justo las que nadie está mirando cuando fallan.
 *
 * Promueve la conexión activa más antigua. No pisa una primary existente.
 */
async function asegurarPrimary(channel: Channel): Promise<void> {
  const promovida = await pool.query<{ id: string }>(
    `UPDATE channel_connections SET is_primary = true, updated_at = now()
     WHERE id = (
       SELECT id FROM channel_connections
       WHERE channel = $1 AND active
       ORDER BY created_at
       LIMIT 1
     )
     AND NOT EXISTS (
       SELECT 1 FROM channel_connections WHERE channel = $1 AND is_primary
     )
     RETURNING id`,
    [channel],
  );
  if (promovida.rows[0]) {
    logger.warn(
      { event: "conexiones.primary_restaurada", channel, connection_id: promovida.rows[0].id },
      "El canal no tenía conexión primary — se promovió la más antigua activa",
    );
    invalidateConnectionsCache();
  }
}

/**
 * Apunta a la conexión primary de WhatsApp las conversaciones que quedaron
 * sin `connection_id` — las anteriores a la migración 0053, que por
 * definición son todas de WhatsApp.
 *
 * No es cosmético: una conversación huérfana sin conexión hace que
 * `recoverOrphanedConversations` (debounceScheduler.ts) la reprograme, falle
 * al resolver el adapter y lo reintente **en cada arranque, para siempre**.
 * Idempotente: en cuanto no queden filas en `NULL` el UPDATE no toca nada.
 */
async function backfillConversationsSinConexion(): Promise<void> {
  const primary = await getPrimaryConnection("whatsapp");
  if (!primary) {
    return;
  }
  const actualizadas = await pool.query(
    "UPDATE conversations SET connection_id = $1 WHERE connection_id IS NULL AND channel = 'whatsapp'",
    [primary.id],
  );
  if (actualizadas.rowCount) {
    logger.info(
      { event: "conexiones.backfill", conversaciones: actualizadas.rowCount, connection_id: primary.id },
      "Conversaciones sin conexión apuntadas a la conexión primary de WhatsApp",
    );
  }
}
