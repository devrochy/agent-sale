import { env } from "./config/env.js";
import { buildServer } from "./gateway/server.js";
import { startConsumer } from "./orchestrator/consumer.js";

/**
 * Entrypoint único del monolito modular: arranca el servidor HTTP del
 * gateway y el consumer del orchestrator en el mismo proceso Node (ver
 * ADR de Fase 2 — monolito, no microservicios).
 */
const app = buildServer();

app
  .listen({ port: env.port, host: "0.0.0.0" })
  .then(() => startConsumer())
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
