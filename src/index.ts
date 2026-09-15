import { env } from "./config/env.js";
import { buildServer } from "./gateway/server.js";
import { startJobScheduler } from "./jobs/scheduler.js";
import { requestConsumerShutdown, startConsumer } from "./orchestrator/consumer.js";
import { requestDebounceSchedulerShutdown, startDebounceScheduler } from "./orchestrator/debounceScheduler.js";
import { ensureConnectionsFromEnv, ensureSettingsRow } from "./shared/db/index.js";
import { pool } from "./shared/db/pool.js";
import { logger } from "./shared/observability/logger.js";
import { redis } from "./shared/redis/client.js";

/**
 * Entrypoint único del monolito modular: arranca el servidor HTTP del
 * gateway y el consumer del orchestrator en el mismo proceso Node (ver
 * ADR de Fase 2 — monolito, no microservicios). El debounce scheduler
 * (Velocidad de respuesta, ver ADR-022) corre en paralelo con el
 * consumer, no encadenado — ambos son loops `while(!shuttingDown)`
 * infinitos, si quedara encadenado el segundo nunca arrancaría.
 * `startJobScheduler` (Fase 12.2, ADR-018) es distinto: solo *registra*
 * los cron jobs (llamada síncrona, no un loop), así que no entra al
 * `Promise.all` ni al shutdown de abajo.
 */
// Antes de aceptar tráfico: sin la conexión sembrada, el primer webhook
// entrante no encontraría a qué conexión pertenece y el mensaje del cliente
// se perdería (Twilio no reintenta de forma confiable). Es idempotente.
// La fila singleton de `settings` no nace de ninguna migración (ver
// ensureSettingsRow): sin ella el panel responde 404 en /login y una
// instalación nueva parece rota. Va antes que las conexiones porque el
// panel es lo primero que se abre en un despliegue recién hecho.
await ensureSettingsRow();
await ensureConnectionsFromEnv();

const app = await buildServer();

// Referencias a los loops (ver el bloque de shutdown más abajo) — se
// llenan dentro del `.then()` porque solo tiene sentido arrancarlos una
// vez que el servidor ya está aceptando tráfico.
let consumerLoop: Promise<void> | undefined;
let debounceLoop: Promise<void> | undefined;

app
  .listen({ port: env.port, host: "0.0.0.0" })
  .then(() => {
    startJobScheduler();
    consumerLoop = startConsumer();
    debounceLoop = startDebounceScheduler();
    return Promise.all([consumerLoop, debounceLoop]);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });

/**
 * Graceful shutdown (Fase 4 del plan de remediación del incidente
 * 2026-09-13): antes no había ningún manejo de SIGTERM — un redeploy o
 * restart de Coolify mataba el proceso de golpe, a mitad de un turno en
 * curso si justo había uno. Orden: (1) dejar de tomar mensajes/turnos
 * NUEVOS, (2) cerrar el servidor HTTP (no acepta más webhooks — Meta
 * reintenta los que no se llegaron a recibir, no se pierden), (3) esperar
 * — con un tope de `env.shutdownGraceMs` — a que el consumer y el
 * debounce scheduler terminen lo que ya tenían en curso, (4) cerrar
 * Redis/Postgres limpio. Si el trabajo en curso no termina dentro del
 * tope, se cierra igual — ese mensaje queda sin XACK y se recupera solo
 * al reiniciar (Fase 5, XAUTOCLAIM).
 *
 * Idempotente ante señales repetidas (Coolify/Docker pueden mandar más de
 * una) vía el flag `shuttingDown` — la segunda señal no reinicia el
 * proceso de apagado.
 */
let shuttingDown = false;

async function handleShutdownSignal(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ event: "shutdown.iniciado", signal }, "Señal de apagado recibida, iniciando shutdown ordenado");

  requestConsumerShutdown();
  requestDebounceSchedulerShutdown();

  try {
    await app.close();
  } catch (error) {
    logger.error({ error }, "Error cerrando el servidor HTTP durante el shutdown");
  }

  const loops = Promise.all(
    [consumerLoop, debounceLoop].filter((loop): loop is Promise<void> => loop !== undefined),
  );
  const grace = new Promise<void>((resolve) => setTimeout(resolve, env.shutdownGraceMs));
  await Promise.race([loops, grace]);

  try {
    await redis.quit();
  } catch (error) {
    logger.error({ error }, "Error cerrando la conexión de Redis durante el shutdown");
  }
  try {
    await pool.end();
  } catch (error) {
    logger.error({ error }, "Error cerrando el pool de Postgres durante el shutdown");
  }

  logger.info({ event: "shutdown.completo" }, "Shutdown completo");
  process.exit(0);
}

// SIGTERM: lo que manda Coolify/Docker al detener el contenedor (deploy
// nuevo, restart manual, o el propio /healthz marcándolo unhealthy — ver
// Fase 3). SIGINT: Ctrl+C en desarrollo local — mismo manejo, conveniencia.
process.on("SIGTERM", handleShutdownSignal);
process.on("SIGINT", handleShutdownSignal);
