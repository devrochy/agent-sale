import { logger } from "../shared/observability/logger.js";
import { startConsumer } from "./consumer.js";

startConsumer().catch((error) => {
  logger.error({ error }, "El consumer del orchestrator terminó con error");
  process.exit(1);
});
