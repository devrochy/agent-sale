import { startConsumer } from "./consumer.js";

startConsumer().catch((error) => {
  console.error("El consumer del orchestrator terminó con error", error);
  process.exit(1);
});
