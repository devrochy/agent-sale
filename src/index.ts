import { env } from "./config/env.js";
import { buildServer } from "./gateway/server.js";
import { startJobScheduler } from "./jobs/scheduler.js";
import { startConsumer } from "./orchestrator/consumer.js";
import { startDebounceScheduler } from "./orchestrator/debounceScheduler.js";
import { ensureConnectionsFromEnv } from "./shared/db/index.js";

/**
 * Entrypoint único del monolito modular: arranca el servidor HTTP del
 * gateway y el consumer del orchestrator en el mismo proceso Node (ver
 * ADR de Fase 2 — monolito, no microservicios). El debounce scheduler
 * (Velocidad de respuesta, ver ADR-022) corre en paralelo con el
 * consumer, no encadenado — ambos son loops `while(true)` infinitos, si
 * quedara encadenado el segundo nunca arrancaría. `startJobScheduler`
 * (Fase 12.2, ADR-018) es distinto: solo *registra* los cron jobs
 * (llamada síncrona, no un loop), así que no entra al `Promise.all`.
 */
// Antes de aceptar tráfico: sin la conexión sembrada, el primer webhook
// entrante no encontraría a qué conexión pertenece y el mensaje del cliente
// se perdería (Twilio no reintenta de forma confiable). Es idempotente.
await ensureConnectionsFromEnv();

const app = await buildServer();

app
  .listen({ port: env.port, host: "0.0.0.0" })
  .then(() => {
    startJobScheduler();
    return Promise.all([startConsumer(), startDebounceScheduler()]);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
