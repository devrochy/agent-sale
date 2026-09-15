import { env } from "./config/env.js";
import { buildServer } from "./gateway/server.js";
import { startJobScheduler } from "./jobs/scheduler.js";
import { startConsumer } from "./orchestrator/consumer.js";
import { startDebounceScheduler } from "./orchestrator/debounceScheduler.js";
import { ensureConnectionsFromEnv, ensureSettingsRow } from "./shared/db/index.js";
import { logger } from "./shared/observability/logger.js";

/**
 * Red de seguridad final (Fase 6 del plan de remediación del incidente
 * 2026-09-13): antes no había ningún handler global, así que una promesa
 * rechazada sin `.catch()` en algún punto no revisado del código quedaba
 * completamente silenciosa (Node ni siquiera la loguea por default en
 * producción) — o, peor, una excepción realmente no capturada podía
 * dejar al proceso vivo pero en un estado interno inconsistente sin que
 * nadie se enterara. `unhandledRejection` se loguea pero no mata el
 * proceso (no hay motivo para ser más frágil que antes ante un bug
 * puntual); `uncaughtException` si lo hace — el estado ya no es
 * confiable — y con el `/healthz` real de la Fase 3, el contenedor se
 * reinicia solo.
 */
process.on("unhandledRejection", (reason) => {
  logger.error({ event: "process.unhandled_rejection", reason }, "Promise rechazada sin catch");
});
process.on("uncaughtException", (error) => {
  logger.error(
    { event: "process.uncaught_exception", error },
    "Excepción no capturada — el proceso puede quedar en estado inconsistente, saliendo",
  );
  process.exit(1);
});

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
// La fila singleton de `settings` no nace de ninguna migración (ver
// ensureSettingsRow): sin ella el panel responde 404 en /login y una
// instalación nueva parece rota. Va antes que las conexiones porque el
// panel es lo primero que se abre en un despliegue recién hecho.
await ensureSettingsRow();
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
