/**
 * Herramienta manual (no forma parte de la app ni de los tests
 * automatizados) para resolver el botón roto de la plantilla
 * "pago_aprobado": el botón "Dejar reseña" quedó apuntando a un dominio
 * de túnel Cloudflare efímero, baked-in al momento de aprobarla (ver
 * `scripts/crear-plantillas-2026-09.ts`, que arma `ctaUrl` con el origin
 * de `PUBLIC_WEBHOOK_URL` de la máquina donde se corrió el script en su
 * momento) — Meta no permite editar una plantilla aprobada, y borrar y
 * recrear con el MISMO nombre la bloquea por semanas (ya pasó con
 * "pedido_confirmado", ver el comentario de ese script). Por eso esto
 * crea "pago_aprobado_v2" (mismo patrón que "pedido_confirmado_v3") en
 * vez de tocar la vieja — la reseña ya no depende de ningún botón/dominio
 * fijo: se unificó con la encuesta de satisfacción 1-5
 * (orchestrator/satisfactionSurvey.ts), que genera el link de reseña real
 * en el momento, como texto libre. "pago_aprobado" (sin "_v2") queda sin
 * usar, no hace falta borrarla.
 *
 * Uso:
 *   npx tsx scripts/recrear-plantilla-pago-aprobado.ts
 */
import "dotenv/config";
import { crearPlantilla } from "../src/admin/adminPanel.js";
import { listAdmins } from "../src/admin/auth/adminsDirectory.js";
import { pool } from "../src/shared/db/pool.js";
import { listTemplates } from "../src/shared/db/whatsappTemplatesDirectory.js";

async function main() {
  const admins = await listAdmins();
  const admin = admins.find((a) => a.role === "master" && a.active);
  if (!admin) {
    throw new Error("No hay ningún admin 'master' activo — hace falta uno para created_by_admin_id.");
  }

  const existentes = await listTemplates();
  const referencia = existentes.find((t) => t.name === "pago_aprobado");
  if (!referencia) {
    throw new Error("No encontré la plantilla 'pago_aprobado' existente — no puedo tomar su conexión de WhatsApp/Meta.");
  }
  const connectionId = referencia.connectionId;

  const yaExiste = existentes.find((t) => t.name === "pago_aprobado_v2");
  if (yaExiste) {
    console.log(`⏭  pago_aprobado_v2: ya existe en la base (status=${yaExiste.status}) — no se crea de nuevo.`);
    return;
  }

  const resultado = await crearPlantilla(admin, {
    connectionId,
    name: "pago_aprobado_v2",
    category: "UTILITY",
    language: "es",
    body: "🎉 ¡Pago aprobado! Tu pedido #{{1}} por {{2}} ya está confirmado. Estamos alistando todo para enviarlo.",
    bodyExamples: "FM-0001, $150.000",
  });
  console.log(resultado.ok ? "✅ pago_aprobado_v2: creada en Meta y guardada." : `❌ pago_aprobado_v2: ${resultado.error}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
