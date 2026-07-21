/**
 * Herramienta manual (no forma parte de la app ni de los tests
 * automatizados): siembra un tenant + producto de prueba y encola un
 * mensaje en whatsapp:inbound, para poder probar el orchestrator contra
 * Claude real sin necesitar todavía una cuenta real de Twilio.
 *
 * Uso:
 *   npm run manual:seed-test-message -- "Hola, tienen cascos?"
 *
 * Después, en otra terminal (con ANTHROPIC_API_KEY real en .env):
 *   npm run build && node dist/src/index.js
 */
import "dotenv/config";
import { Redis } from "ioredis";
import pg from "pg";

const { Pool } = pg;

const TEST_TENANT_WHATSAPP_NUMBER = "whatsapp:+573000000000";
const TEST_CUSTOMER_PHONE = "whatsapp:+573001111111";
const TEST_SKU = "CASCO-1";
const INBOUND_STREAM = "whatsapp:inbound";

async function main() {
  const body = process.argv[2] ?? "Hola, tienen cascos?";

  const pool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

  try {
    const tenant = await pool.query<{ id: string }>(
      `INSERT INTO tenants (name, whatsapp_number)
       VALUES ('ForMotos Test', $1)
       ON CONFLICT (whatsapp_number) DO UPDATE SET whatsapp_number = EXCLUDED.whatsapp_number
       RETURNING id`,
      [TEST_TENANT_WHATSAPP_NUMBER],
    );
    const tenantId = tenant.rows[0]!.id;

    const product = await pool.query<{ id: string }>(
      `INSERT INTO products (tenant_id, sku, name, price)
       VALUES ($1, $2, 'Casco integral de prueba', 300000)
       ON CONFLICT (tenant_id, sku) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [tenantId, TEST_SKU],
    );
    const productId = product.rows[0]!.id;

    // inventory no tiene una constraint única sobre (tenant_id, product_id)
    // — se borra y se vuelve a insertar para que el script sea idempotente
    // (evita filas duplicadas si se corre varias veces).
    await pool.query(`DELETE FROM inventory WHERE product_id = $1`, [productId]);
    await pool.query(
      `INSERT INTO inventory (tenant_id, product_id, stock_quantity) VALUES ($1, $2, 5)`,
      [tenantId, productId],
    );

    const messageSid = `manual-test-${Date.now()}`;
    await redis.xadd(
      INBOUND_STREAM,
      "*",
      "message_sid",
      messageSid,
      "tenant_id",
      tenantId,
      "customer_phone",
      TEST_CUSTOMER_PHONE,
      "body",
      body,
      "received_at",
      new Date().toISOString(),
    );

    console.log("Tenant de prueba:", tenantId);
    console.log("Producto de prueba:", productId, `(sku=${TEST_SKU}, stock=5)`);
    console.log(`Mensaje encolado (message_sid=${messageSid}) en "${INBOUND_STREAM}":`);
    console.log(`  de ${TEST_CUSTOMER_PHONE}: "${body}"`);
    console.log("\nAhora corré (en otra terminal, con ANTHROPIC_API_KEY real en .env):");
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
