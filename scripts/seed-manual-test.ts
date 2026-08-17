/**
 * Herramienta manual (no forma parte de la app ni de los tests
 * automatizados): encola un mensaje entrante en el stream, como si hubiera
 * llegado por el webhook, para probar el orchestrator contra el LLM real sin
 * depender de un proveedor de mensajería.
 *
 * Desde la Etapa C1 de la Fase 19 (ver ADR-037) acepta el canal, que es la
 * única forma de ejercitar a mano la identidad por canal antes de que existan
 * los adapters de Instagram y Messenger (Etapas C2/C3).
 *
 * Uso:
 *   npm run manual:seed-test-message -- "Hola, tienen cascos?"
 *   npm run manual:seed-test-message -- "Hola" --channel=instagram
 *   npm run manual:seed-test-message -- "Hola" --channel=instagram --from=17841400000009001
 *   npm run manual:seed-test-message -- "Hola" --name="Camila Pérez"
 *
 * Ya no siembra catálogo: eso es trabajo de `npm run seed:catalogo-prueba`,
 * que sí está al día con el esquema de la Fase 14. La versión anterior de
 * este script insertaba en `tenants` (tabla eliminada en la migración 0036,
 * ADR-032) y en `products (tenant_id, sku, price)` (columnas que la Fase 14
 * movió a `product_variants`), así que llevaba roto desde esos merges.
 *
 * Después, en otra terminal (con las credenciales del proveedor LLM
 * configurado en .env — ver LLM_PROVIDER en .env.example):
 *   npm run build && node dist/src/index.js
 */
import "dotenv/config";
import { enqueueInboundMessage } from "../src/gateway/queue.js";
import {
  getPrimaryConnection,
  type Channel,
} from "../src/shared/db/connectionsDirectory.js";
import { pool } from "../src/shared/db/pool.js";
import { redis } from "../src/shared/redis/client.js";

const CHANNELS: Channel[] = ["whatsapp", "instagram", "messenger"];

/**
 * Una dirección de prueba por canal. Las de Instagram y Messenger imitan la
 * forma real de un IGSID y un PSID: cadenas numéricas largas, sin ninguna
 * marca que las distinga de un teléfono. Esa ambigüedad es justamente lo que
 * motivó `UNIQUE (channel, external_id)` en la migración 0054.
 */
const DEFAULT_FROM: Record<Channel, string> = {
  whatsapp: "whatsapp:+573001111111",
  instagram: "17841400000009001",
  messenger: "79014100000009001",
};

interface Args {
  body: string;
  channel: Channel;
  from: string;
  name: string;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (const arg of argv) {
    const match = /^--([a-z]+)=(.*)$/.exec(arg);
    if (match) {
      flags.set(match[1]!, match[2]!);
    } else {
      positional.push(arg);
    }
  }

  const channel = (flags.get("channel") ?? "whatsapp") as Channel;
  if (!CHANNELS.includes(channel)) {
    // Error de uso, no un fallo del sistema: un stack trace acá solo tapa el
    // mensaje que la persona necesita leer.
    console.error(`Canal desconocido: "${channel}". Opciones: ${CHANNELS.join(", ")}`);
    process.exit(1);
  }

  return {
    body: positional[0] ?? "Hola, tienen cascos?",
    channel,
    from: flags.get("from") ?? DEFAULT_FROM[channel],
    name: flags.get("name") ?? "Cliente de Prueba",
  };
}

/** Aviso temprano: sin catálogo el agente no tiene nada que cotizar. */
async function warnIfCatalogEmpty(): Promise<void> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM product_variants WHERE active = true`,
  );
  if (result.rows[0]!.count === "0") {
    console.warn("⚠  No hay variantes activas en el catálogo — corré antes:");
    console.warn("     npm run seed:catalogo-prueba\n");
  }
}

/**
 * Imprime la identidad `(channel, external_id)` y, si el teléfono de contacto
 * coincide con el de otra identidad, la muestra: es exactamente el vínculo que
 * `crearPedido` usa para reusar los datos de entrega entre canales (ADR-037),
 * y verlo antes y después de la prueba es la forma de comprobar a mano que
 * funciona.
 */
async function describeIdentity(channel: Channel, externalId: string): Promise<void> {
  const propio = await pool.query<{
    id: string;
    name: string | null;
    contact_phone: string | null;
    full_name: string | null;
    address: string | null;
  }>(
    `SELECT id, name, contact_phone, full_name, address
     FROM customers WHERE channel = $1 AND external_id = $2`,
    [channel, externalId],
  );

  const cliente = propio.rows[0];
  if (!cliente) {
    console.log(`Identidad (${channel}, ${externalId}): nueva, se creará al procesar el mensaje.`);
    return;
  }

  console.log(`Identidad (${channel}, ${externalId}): cliente ${cliente.id}`);
  console.log(`  nombre=${cliente.name ?? "—"} teléfono=${cliente.contact_phone ?? "—"}`);
  console.log(
    `  datos de entrega propios: ${cliente.full_name && cliente.address ? "sí" : "no"}`,
  );

  if (!cliente.contact_phone) {
    console.log("  sin teléfono de contacto todavía → no hay cruce posible con otros canales.");
    return;
  }

  const hermanas = await pool.query<{ channel: string; external_id: string; address: string | null }>(
    `SELECT channel, external_id, address
     FROM customers
     WHERE contact_phone = $1 AND id <> $2
     ORDER BY created_at ASC`,
    [cliente.contact_phone, cliente.id],
  );

  if (hermanas.rows.length === 0) {
    console.log("  sin otras identidades con ese teléfono.");
    return;
  }

  console.log("  otras identidades con el mismo teléfono (fuente del cruce en crearPedido):");
  for (const fila of hermanas.rows) {
    console.log(
      `    (${fila.channel}, ${fila.external_id}) datos de entrega: ${fila.address ? "sí" : "no"}`,
    );
  }
}

async function main() {
  const { body, channel, from, name } = parseArgs(process.argv.slice(2));

  try {
    await warnIfCatalogEmpty();

    // La conexión determina por dónde sale la respuesta. Para un canal sin
    // conexión configurada el mensaje se procesa igual (se crea el cliente, la
    // conversación y el pedido), pero el envío falla en `resolveTarget`, que
    // cae a `requirePrimary(channel)`. Es una limitación real de probar
    // Instagram antes de la Etapa C2, no un problema del script.
    const connection = await getPrimaryConnection(channel);
    if (!connection) {
      console.warn(`⚠  No hay conexión primaria activa para "${channel}".`);
      console.warn("     El mensaje se procesará, pero la respuesta no podrá enviarse.");
      console.warn("     Sirve para verificar la base y el panel, no la conversación completa.\n");
    }

    await describeIdentity(channel, from);

    const messageSid = `manual-test-${Date.now()}`;
    await enqueueInboundMessage({
      messageSid,
      customerExternalId: from,
      customerName: name,
      body,
      receivedAt: new Date().toISOString(),
      connectionId: connection?.id,
      channel,
    });

    console.log(`\nMensaje encolado (message_sid=${messageSid}):`);
    console.log(`  canal=${channel} de=${from} nombre="${name}"`);
    console.log(`  conexión=${connection ? `${connection.provider} (${connection.id})` : "ninguna"}`);
    console.log(`  cuerpo: "${body}"`);
    console.log("\nAhora corré (en otra terminal, con las credenciales del proveedor LLM en .env):");
    console.log("  npm run build && node dist/src/index.js");
  } finally {
    await pool.end();
    redis.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
