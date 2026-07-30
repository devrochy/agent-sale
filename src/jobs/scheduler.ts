import cron from "node-cron";
import { logger } from "../shared/observability/logger.js";
import { runCazadorDeVentas } from "./cazadorDeVentas.js";
import { sendDailyReports } from "./dailyReport.js";

/**
 * Jobs programados (ADR-018, docs/fase-12-capacidades-proactivas-agente/):
 * `node-cron` en el mismo proceso Fastify, sin infraestructura distribuida
 * — Fly.io mantiene una sola instancia siempre activa (ADR-005), así que no
 * hace falta coordinación entre instancias para evitar que un job corra
 * dos veces. Cada job atrapa sus propios errores acá adentro (además del
 * try/catch por tenant que ya tiene `sendDailyReports`): un job que falla
 * no debe tumbar el proceso ni afectar el webhook.
 *
 * Se llama desde src/index.ts, no desde buildServer() — así los tests de
 * integración (que usan buildServer()+.inject(), nunca index.ts) no
 * arrancan cron jobs reales.
 */
export function startJobScheduler(): void {
  cron.schedule(
    "0 8 * * *",
    async () => {
      try {
        await sendDailyReports();
      } catch (error) {
        logger.error(
          { error, event: "jobs.reporte_diario_fallido" },
          "Falló la corrida del Reporte diario",
        );
      }
    },
    { timezone: "America/Bogota" },
  );

  cron.schedule(
    "0 * * * *",
    async () => {
      try {
        await runCazadorDeVentas();
      } catch (error) {
        logger.error(
          { error, event: "jobs.cazador_ventas_fallido" },
          "Falló la corrida del Cazador de ventas",
        );
      }
    },
    { timezone: "America/Bogota" },
  );
}
