import { escapeHtml } from "../advisor/handoffView.js";
import { getReviewLink, getTenant, resolveReviewToken, withTenant } from "../shared/db/index.js";
import type { TenantSummary } from "../shared/db/tenantsDirectory.js";

function brandName(tenant: TenantSummary): string {
  return tenant.display_name ?? tenant.name;
}

interface ReviewContext {
  tenantId: string;
  conversationId: string;
  customerId: string;
  score: number | null;
  tenant: TenantSummary;
  existingReviewText: string | null;
}

async function loadContext(token: string): Promise<ReviewContext | null> {
  const lookup = await resolveReviewToken(token);
  if (!lookup) {
    return null;
  }
  const tenant = await getTenant(lookup.tenantId);
  if (!tenant) {
    return null;
  }
  const data = await withTenant(lookup.tenantId, async (client) => {
    const conversation = await client.query<{
      customer_id: string;
      satisfaction_score: number | null;
    }>(`SELECT customer_id, satisfaction_score FROM conversations WHERE id = $1`, [
      lookup.conversationId,
    ]);
    const existing = await client.query<{ review_text: string }>(
      `SELECT review_text FROM reviews WHERE conversation_id = $1`,
      [lookup.conversationId],
    );
    return {
      customerId: conversation.rows[0]?.customer_id ?? null,
      score: conversation.rows[0]?.satisfaction_score ?? null,
      existingReviewText: existing.rows[0]?.review_text ?? null,
    };
  });
  if (!data.customerId) {
    return null;
  }
  return {
    tenantId: lookup.tenantId,
    conversationId: lookup.conversationId,
    customerId: data.customerId,
    score: data.score,
    tenant,
    existingReviewText: data.existingReviewText,
  };
}

function renderFormPage(token: string, brand: string, error?: string): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(brand)} — Tu opinión nos importa</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    h1 { font-size: 1.3rem; }
    textarea { width: 100%; min-height: 120px; font: inherit; padding: 0.6rem; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; }
    button { margin-top: 0.75rem; padding: 0.6rem 1.2rem; font-size: 1rem; cursor: pointer; border-radius: 6px; border: none; background: #1a73e8; color: #fff; }
    .error { color: #c0392b; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>¿Cómo fue tu experiencia con ${escapeHtml(brand)}?</h1>
  <p>Contanos con tus palabras — nos ayuda a mejorar.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="POST" action="/resena/${token}">
    <textarea name="review_text" required placeholder="Escribí tu reseña acá..."></textarea>
    <br>
    <button type="submit">Enviar</button>
  </form>
</body>
</html>`;
}

function renderThanksPage(brand: string, shareUrl: string | null): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(brand)} — ¡Gracias!</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; text-align: center; }
    a.btn { display: inline-block; margin-top: 1rem; padding: 0.6rem 1.2rem; font-size: 1rem; border-radius: 6px; background: #1a73e8; color: #fff; text-decoration: none; }
  </style>
</head>
<body>
  <h1>¡Gracias por tu reseña! 🙏</h1>
  <p>La tuvimos en cuenta.</p>
  ${
    shareUrl
      ? `<p>Si tenés un minuto más, nos ayudaría muchísimo que también la compartas públicamente:</p><a class="btn" href="${escapeHtml(shareUrl)}">Compartir en Google</a>`
      : ""
  }
</body>
</html>`;
}

export interface ReviewViewResult {
  status: number;
  html?: string;
}

/**
 * Página pública (sin `layout()` del panel admin — ese trae sidebar/nav
 * pensado para el dueño del negocio, no para un cliente anónimo desde el
 * celular, mismo criterio que `handoffView.ts`). Idempotente: si la
 * conversación ya tiene una reseña, no vuelve a mostrar el form.
 */
export async function renderReviewForm(token: string): Promise<ReviewViewResult> {
  const ctx = await loadContext(token);
  if (!ctx) {
    return { status: 404 };
  }
  const brand = brandName(ctx.tenant);
  if (ctx.existingReviewText !== null) {
    const externalLink = await getReviewLink(ctx.tenantId);
    return {
      status: 200,
      html: renderThanksPage(brand, externalLink ? `/resena/${token}/compartir` : null),
    };
  }
  return { status: 200, html: renderFormPage(token, brand) };
}

/**
 * Guarda la reseña — `ON CONFLICT (conversation_id) DO NOTHING` (índice
 * único en `reviews.conversation_id`, migrations/0028) es la defensa real
 * contra duplicados; el chequeo de `existingReviewText` en `loadContext`
 * evita la escritura en el caso normal, pero la constraint es la que
 * garantiza que un doble-submit no cree dos filas.
 */
export async function submitReview(token: string, reviewText: string): Promise<ReviewViewResult> {
  const ctx = await loadContext(token);
  if (!ctx) {
    return { status: 404 };
  }
  const brand = brandName(ctx.tenant);
  const trimmed = reviewText.trim();
  if (trimmed === "") {
    return {
      status: 200,
      html: renderFormPage(token, brand, "Escribinos algo antes de enviar 🙂"),
    };
  }

  if (ctx.existingReviewText === null) {
    await withTenant(ctx.tenantId, (client) =>
      client.query(
        `INSERT INTO reviews (tenant_id, conversation_id, customer_id, score, review_text)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (conversation_id) DO NOTHING`,
        [ctx.tenantId, ctx.conversationId, ctx.customerId, ctx.score, trimmed],
      ),
    );
  }

  const externalLink = await getReviewLink(ctx.tenantId);
  return {
    status: 200,
    html: renderThanksPage(brand, externalLink ? `/resena/${token}/compartir` : null),
  };
}

export interface ShareReviewResult {
  status: number;
  redirectUrl?: string;
}

/**
 * "Compartir en Google" — paso posterior opcional a la reseña interna
 * (ver contexto del PR). 404 si el tenant no configuró el link externo
 * (`tenants.review_link`) — nunca redirige a un link inventado.
 */
export async function shareReviewPublicly(token: string): Promise<ShareReviewResult> {
  const lookup = await resolveReviewToken(token);
  if (!lookup) {
    return { status: 404 };
  }
  const externalLink = await getReviewLink(lookup.tenantId);
  if (!externalLink) {
    return { status: 404 };
  }
  await withTenant(lookup.tenantId, (client) =>
    client.query(`UPDATE reviews SET shared_publicly = true WHERE conversation_id = $1`, [
      lookup.conversationId,
    ]),
  );
  return { status: 302, redirectUrl: externalLink };
}
