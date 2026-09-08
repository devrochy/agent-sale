/**
 * Herramienta manual (no forma parte de la app ni de los tests
 * automatizados) para crear en Meta las 6 plantillas de WhatsApp que
 * faltaban del catálogo (ver docs/fase-3-whatsapp-gateway/
 * plantillas-mensajes.md) y recrear `pedido_confirmado` con el cuerpo y el
 * botón "Confirmar y pagar" nuevos (Meta no tiene edición de plantillas —
 * hay que borrar y volver a crear, así que esta sí es destructiva sobre una
 * plantilla ya aprobada).
 *
 * Reusa `crearPlantilla`/`eliminarPlantilla` (src/admin/adminPanel.ts) tal
 * cual las usa el panel — mismo flujo, misma validación de botones, y deja
 * el registro en `whatsapp_templates` igual que si se hubiera hecho desde
 * `/admin/plantillas`.
 *
 * Uso:
 *   npx tsx scripts/crear-plantillas-2026-09.ts
 */
import "dotenv/config";
import { crearPlantilla, eliminarPlantilla } from "../src/admin/adminPanel.js";
import { listAdmins } from "../src/admin/auth/adminsDirectory.js";
import { env } from "../src/config/env.js";
import { pool } from "../src/shared/db/pool.js";
import { listTemplates } from "../src/shared/db/whatsappTemplatesDirectory.js";

type TemplateInput = Parameters<typeof crearPlantilla>[1];

async function main() {
  const admins = await listAdmins();
  const admin = admins.find((a) => a.role === "master" && a.active);
  if (!admin) {
    throw new Error("No hay ningún admin 'master' activo — hace falta uno para created_by_admin_id.");
  }

  const existentes = await listTemplates();
  const conexionDeReferencia = existentes.find((t) => t.name === "confirmar_domicilio" || t.name === "metodo_pago");
  if (!conexionDeReferencia) {
    throw new Error("No encontré ninguna plantilla existente para tomar la conexión de WhatsApp/Meta.");
  }
  const connectionId = conexionDeReferencia.connectionId;

  // Mismo origin que usa notificarPagoCliente.ts para el link de reseña real
  // (nunca el PUBLIC_WEBHOOK_URL completo, que trae el path del webhook).
  const origin = new URL(env.publicWebhookUrl).origin;

  const nuevas: { name: string; input: TemplateInput }[] = [
    {
      name: "metodo_pago",
      input: {
        connectionId,
        name: "metodo_pago",
        category: "UTILITY",
        language: "es",
        body: "🛒 ¡Ya casi terminamos, {{1}}! Para tu pedido de {{2}}, ¿cómo preferís pagar? Elegí la opción que te quede más cómoda.",
        bodyExamples: "Juan Pérez, $150.000",
        quickReply1: "Transferencia",
        quickReply2: "Pago en línea",
        quickReply3: "Contra entrega",
      },
    },
    {
      name: "pago_aprobado",
      input: {
        connectionId,
        name: "pago_aprobado",
        category: "UTILITY",
        language: "es",
        body: "🎉 ¡Pago aprobado! Tu pedido #{{1}} por {{2}} ya está confirmado. Estamos alistando todo para enviarlo. Si tenés un momento, contanos cómo te fue:",
        bodyExamples: "FM-0001, $150.000",
        ctaLabel: "Dejar reseña",
        ctaUrl: `${origin}/resena/{{1}}`,
        ctaUrlExample: "abc123def456",
      },
    },
    {
      name: "pago_rechazado",
      input: {
        connectionId,
        name: "pago_rechazado",
        category: "UTILITY",
        language: "es",
        body: "⚠️ Tu pago del pedido #{{1}} por {{2}} no pudo procesarse. Podés intentar de nuevo o elegir otro método. Contanos y lo resolvemos juntos.",
        bodyExamples: "FM-0001, $150.000",
      },
    },
    {
      name: "pedido_en_camino",
      input: {
        connectionId,
        name: "pedido_en_camino",
        category: "UTILITY",
        language: "es",
        body: "🚚 ¡Tu pedido #{{1}} ya está en camino! Número de guía: {{2}} con {{3}}. Cualquier novedad, avísanos.",
        bodyExamples: "FM-0001, 123456789, Servientrega",
      },
    },
    {
      name: "carrito_abandonado",
      input: {
        connectionId,
        name: "carrito_abandonado",
        category: "MARKETING",
        language: "es",
        body: "👋 Hola {{1}}, ¿seguís interesado en {{2}}? Vimos tu cotización por {{3}}. Si querés, seguimos con tu pedido. ¡Estamos atentos!",
        bodyExamples: "Juan Pérez, casco integral talla M, $150.000",
      },
    },
    {
      name: "pedido_cancelado",
      input: {
        connectionId,
        name: "pedido_cancelado",
        category: "UTILITY",
        language: "es",
        body: "📢 Tu pedido #{{1}} fue cancelado. Si fue un error o querés hacer un pedido nuevo, escribinos 🙌 ¡Estamos para ayudarte!",
        bodyExamples: "FM-0001",
      },
    },
    {
      // Sin nombre fijo en el código — "Mandar promoción" en Leads lista
      // cualquier plantilla MARKETING aprobada (ver enviarPromocionCliente,
      // adminPanel.ts). "promocion_general" es el nombre elegido acá.
      name: "promocion_general",
      input: {
        connectionId,
        name: "promocion_general",
        category: "MARKETING",
        language: "es",
        body: "🔥 ¡{{1}} en ForMotos! {{2}}% de descuento en {{3}} hasta el {{4}}. ¡No te lo pierdas!",
        bodyExamples: "Black Friday, 20, cascos, 30/11",
      },
    },
  ];

  // "pedido_confirmado" a secas: Meta la bloqueó al intentar borrar+recrear
  // (dijo "4 weeks"). Se creó "_v2" en su lugar, pero borrarla para
  // recrearla (bug del script, ver más abajo) la volvió a bloquear — otra
  // vez con un mensaje de tiempo que no se cumplió ("less than 1 minute",
  // y siguió bloqueada 5+ minutos). Se crea con "_v3" en vez de seguir
  // reintentando a ciegas — ver docs/fase-3-whatsapp-gateway/plantillas-mensajes.md.
  const pedidoConfirmadoInput: TemplateInput = {
    connectionId,
    name: "pedido_confirmado_v3",
    category: "UTILITY",
    language: "es",
    body: "✅ ¡Gracias, {{1}}! Tu pedido #{{2}} por {{3}} quedó confirmado. 📦 Entrega: {{4}}. Cualquier cosa, estamos acá para ayudarte.",
    bodyExamples: "Juan Pérez, FM-0001, $150.000, Domicilio",
    quickReply1: "Agregar productos",
    quickReply2: "Cancelar pedido",
    quickReply3: "Confirmar y pagar",
  };

  console.log(`Conexión usada: ${connectionId}`);
  console.log(`Admin usado para created_by_admin_id: ${admin.username} (${admin.id})`);
  console.log(`Origin para el botón de reseña: ${origin}\n`);

  for (const { name, input } of nuevas) {
    const yaExiste = existentes.find((t) => t.name === name);
    if (yaExiste) {
      console.log(`⏭  ${name}: ya existe en la base (status=${yaExiste.status}) — se salta.`);
      continue;
    }
    const resultado = await crearPlantilla(admin, input);
    if (resultado.ok) {
      console.log(`✅ ${name}: creada en Meta y guardada.`);
    } else {
      console.error(`❌ ${name}: ${resultado.error}`);
    }
  }

  console.log("\n--- pedido_confirmado_v3 ---");
  // "pedido_confirmado" y "pedido_confirmado_v2" quedaron bloqueadas por
  // Meta (ver comentario más arriba) — no se vuelven a tocar acá. Mismo
  // criterio que el loop de arriba: si "pedido_confirmado_v3" ya existe, se
  // salta — NO se borra/recrea sola en cada corrida (eso fue justo el bug
  // que bloqueó "_v2": una corrida pensada solo para "promocion_general"
  // terminó borrándola sin necesidad). Para forzar un borrado+recreación
  // real (ej. si hay que cambiar el cuerpo de nuevo), usar
  // FORZAR_RECREACION_PEDIDO_CONFIRMADO=1 explícitamente — con el riesgo ya
  // visto de quedar bloqueada un rato.
  const actual = existentes.find((t) => t.name === "pedido_confirmado_v3");
  if (!actual) {
    const resultado = await crearPlantilla(admin, pedidoConfirmadoInput);
    console.log(resultado.ok ? "✅ pedido_confirmado_v3: creada." : `❌ pedido_confirmado_v3: ${resultado.error}`);
  } else if (process.env.FORZAR_RECREACION_PEDIDO_CONFIRMADO !== "1") {
    console.log(`⏭  pedido_confirmado_v3: ya existe en la base (status=${actual.status}) — se salta.`);
  } else {
    const borrado = await eliminarPlantilla(actual.id);
    if (!borrado.ok) {
      console.error(`❌ No se pudo borrar pedido_confirmado_v3 en Meta: ${borrado.error}`);
      console.error("No se intenta recrear — quedó como estaba.");
    } else {
      console.log("🗑  pedido_confirmado_v3: borrada en Meta y en la base.");
      const resultado = await crearPlantilla(admin, pedidoConfirmadoInput);
      console.log(resultado.ok ? "✅ pedido_confirmado_v3: recreada." : `❌ pedido_confirmado_v3: ${resultado.error}`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
