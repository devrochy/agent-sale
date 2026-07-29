import { escapeHtml } from "../advisor/handoffView.js";
import { getTenant, listTenants, type TenantSummary } from "../shared/db/tenantsDirectory.js";
import { withTenant } from "../shared/db/withTenant.js";

/**
 * Panel interno de solo lectura (ver docs de Fase 8/9): no hay sistema de
 * login en el proyecto, la protección la da Basic Auth en
 * src/gateway/server.ts. Sirve para operar/depurar el piloto — no es un
 * dashboard de cliente final.
 */

interface ProductoRow {
  sku: string;
  name: string;
  category: string | null;
  price: string;
  description: string | null;
  image_url: string | null;
  stock: string;
}

interface OrderItemJson {
  name: string;
  quantity: number;
  unit_price: string;
}

interface PedidoRow {
  id: string;
  status: string;
  payment_method: string;
  delivery_method: string;
  total: string;
  created_at: string;
  phone_number: string;
  customer_name: string | null;
  items: OrderItemJson[];
}

function formatCOP(value: string | number): string {
  return `$${Number(value).toLocaleString("es-CO")}`;
}

/**
 * Nombre mostrado en el encabezado del panel (ver ADR-016): `display_name`
 * si el tenant lo configuró, si no el `name` operativo — ForMotos no
 * necesita seed, ya sale "ForMotos" por este fallback.
 */
function brandName(tenant: TenantSummary): string {
  return tenant.display_name ?? tenant.name;
}

function layout(title: string, tenant: TenantSummary | null, body: string): string {
  const nav = tenant
    ? `<nav>
        <a href="/admin">Tenants</a> ·
        <a href="/admin/${tenant.id}">Resumen</a> ·
        <a href="/admin/${tenant.id}/productos">Catálogo</a> ·
        <a href="/admin/${tenant.id}/pedidos">Pedidos</a>
      </nav>`
    : "";

  const heading = tenant
    ? `${escapeHtml(brandName(tenant))} — ${escapeHtml(title)}`
    : escapeHtml(title);

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>${heading}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1000px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    nav { margin-bottom: 1.5rem; font-size: 0.9rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #ddd; padding: 0.5rem; text-align: left; vertical-align: top; font-size: 0.85rem; }
    img.thumb { width: 72px; height: 54px; object-fit: cover; border-radius: 4px; }
    .stock-cero { color: #b00020; font-weight: 600; }
    ul.items { margin: 0; padding-left: 1rem; }
    .kpis { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
    .kpi { border: 1px solid #ddd; border-radius: 8px; padding: 0.75rem 1rem; min-width: 160px; }
    .kpi .label { font-size: 0.75rem; color: #666; text-transform: uppercase; }
    .kpi .value { font-size: 1.75rem; font-weight: 700; }
    .conversaciones { list-style: none; margin: 0; padding: 0; }
    .conversaciones li { padding: 0.5rem 0; border-bottom: 1px solid #eee; }
    .conversaciones .meta { font-size: 0.75rem; color: #666; }
  </style>
</head>
<body>
  <h1>${heading}</h1>
  ${nav}
  ${body}
</body>
</html>`;
}

export async function renderTenantsPage(): Promise<string> {
  const tenants = await listTenants();
  const items = tenants
    .map((tenant) => `<li><a href="/admin/${tenant.id}">${escapeHtml(brandName(tenant))}</a></li>`)
    .join("\n");
  return layout("Tenants", null, `<ul>${items}</ul>`);
}

interface OverviewKpiRow {
  mensajes_24h: string;
  clientes_unicos_24h: string;
}

interface ResueltoSinHumanoRow {
  conversaciones_totales: string;
  escaladas: string;
}

interface ActividadDiaRow {
  dia: string;
  mensajes: string;
}

interface ConversacionRecienteRow {
  customer_name: string | null;
  phone_number: string;
  content: string;
  created_at: string;
}

function renderActividadSvg(dias: { label: string; valor: number }[]): string {
  const width = 560;
  const chartHeight = 90;
  const barWidth = 48;
  const gap = (width - barWidth * dias.length) / (dias.length + 1);
  const maxValor = Math.max(1, ...dias.map((d) => d.valor));

  const bars = dias
    .map((d, i) => {
      const x = gap + i * (barWidth + gap);
      const barHeight = Math.max(1, Math.round((d.valor / maxValor) * chartHeight));
      const y = chartHeight - barHeight + 20;
      return `
        <text x="${x + barWidth / 2}" y="14" text-anchor="middle" font-size="11">${d.valor}</text>
        <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="#c65d2e" rx="3"></rect>
        <text x="${x + barWidth / 2}" y="${chartHeight + 36}" text-anchor="middle" font-size="11" fill="#666">${escapeHtml(d.label)}</text>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${chartHeight + 40}" width="100%" height="${chartHeight + 40}" role="img" aria-label="Mensajes por día, últimos 7 días">${bars}</svg>`;
}

/**
 * Home del tenant en el panel (ver docs/fase-11-panel-admin-dashboard/
 * overview-kpis.md, Fase 11.1). Reemplaza el punto de entrada al elegir un
 * tenant en renderTenantsPage() — antes caía directo a Catálogo.
 */
export async function renderOverviewPage(tenantId: string): Promise<string | null> {
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    return null;
  }

  const { kpis, resuelto, actividad, recientes } = await withTenant(tenantId, async (client) => {
    const kpisResult = await client.query<OverviewKpiRow>(
      `SELECT count(*) AS mensajes_24h, count(DISTINCT conv.customer_id) AS clientes_unicos_24h
       FROM messages m
       JOIN conversations conv ON conv.id = m.conversation_id
       WHERE m.created_at >= now() - interval '24 hours'`,
    );

    const resueltoResult = await client.query<ResueltoSinHumanoRow>(
      `SELECT count(DISTINCT c.id) AS conversaciones_totales,
              count(DISTINCT h.conversation_id) AS escaladas
       FROM conversations c
       LEFT JOIN handoff_queue h ON h.conversation_id = c.id
       WHERE c.status = 'closed'
         AND c.closed_at >= now() - interval '7 days'`,
    );

    const actividadResult = await client.query<ActividadDiaRow>(
      // to_char (no ::date) porque el driver de pg parsea columnas `date`
      // como objeto Date, no string — y la fecha se usa como llave de un
      // Map contra strings ISO más abajo.
      `SELECT to_char(date_trunc('day', m.created_at), 'YYYY-MM-DD') AS dia, count(*) AS mensajes
       FROM messages m
       WHERE m.created_at >= now() - interval '7 days'
       GROUP BY 1
       ORDER BY 1`,
    );

    const recientesResult = await client.query<ConversacionRecienteRow>(
      `SELECT c.name AS customer_name, c.phone_number, m.content, m.created_at
       FROM conversations conv
       JOIN customers c ON c.id = conv.customer_id
       JOIN LATERAL (
         SELECT content, created_at FROM messages
         WHERE conversation_id = conv.id
         ORDER BY created_at DESC LIMIT 1
       ) m ON true
       ORDER BY m.created_at DESC
       LIMIT 10`,
    );

    return {
      kpis: kpisResult.rows[0]!,
      resuelto: resueltoResult.rows[0]!,
      actividad: actividadResult.rows,
      recientes: recientesResult.rows,
    };
  });

  const conversacionesTotales = Number(resuelto.conversaciones_totales);
  const escaladas = Number(resuelto.escaladas);
  const pctResueltoSinHumano =
    conversacionesTotales > 0 ? Math.round(100 * (1 - escaladas / conversacionesTotales)) : null;

  // Últimos 7 días, con 0 para los días sin mensajes — la query solo
  // devuelve filas para días con actividad.
  const actividadPorDia = new Map(actividad.map((row) => [row.dia, Number(row.mensajes)]));
  const dias = Array.from({ length: 7 }, (_, i) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - (6 - i));
    const iso = date.toISOString().slice(0, 10);
    const label = `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    return { label, valor: actividadPorDia.get(iso) ?? 0 };
  });

  const conversacionesHtml = recientes
    .map(
      (row) => `<li>
        <strong>${escapeHtml(row.customer_name ?? row.phone_number)}</strong> — ${escapeHtml(row.content)}
        <div class="meta">${escapeHtml(String(row.created_at))}</div>
      </li>`,
    )
    .join("\n");

  const body = `
    <div class="kpis">
      <div class="kpi">
        <div class="label">Mensajes (24h)</div>
        <div class="value">${Number(kpis.mensajes_24h)}</div>
      </div>
      <div class="kpi">
        <div class="label">Clientes únicos (24h)</div>
        <div class="value">${Number(kpis.clientes_unicos_24h)}</div>
      </div>
      <div class="kpi">
        <div class="label">Resueltas sin humano (7d)</div>
        <div class="value">${pctResueltoSinHumano === null ? "—" : `${pctResueltoSinHumano}%`}</div>
      </div>
    </div>
    <h2>Actividad — últimos 7 días</h2>
    ${renderActividadSvg(dias)}
    <h2>Conversaciones recientes</h2>
    <ul class="conversaciones">${conversacionesHtml || "<li>Sin conversaciones todavía.</li>"}</ul>
  `;

  return layout("Resumen", tenant, body);
}

export async function renderProductosPage(tenantId: string): Promise<string | null> {
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    return null;
  }

  const rows = await withTenant(tenantId, async (client) => {
    const result = await client.query<ProductoRow>(
      `SELECT p.sku, p.name, p.category, p.price, p.description, p.image_url,
              COALESCE(i.stock_quantity, 0) AS stock
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id
       ORDER BY p.category, p.name`,
    );
    return result.rows;
  });

  const tableRows = rows
    .map((row) => {
      const stock = Number(row.stock);
      const img = row.image_url
        ? `<img class="thumb" src="${escapeHtml(row.image_url)}" alt="${escapeHtml(row.name)}">`
        : "";
      return `<tr>
        <td>${img}</td>
        <td>${escapeHtml(row.sku)}</td>
        <td>${escapeHtml(row.name)}</td>
        <td>${escapeHtml(row.category ?? "")}</td>
        <td>${formatCOP(row.price)}</td>
        <td class="${stock === 0 ? "stock-cero" : ""}">${stock}</td>
        <td>${escapeHtml(row.description ?? "")}</td>
      </tr>`;
    })
    .join("\n");

  const body = `<table>
    <thead><tr><th>Foto</th><th>SKU</th><th>Nombre</th><th>Categoría</th><th>Precio</th><th>Stock</th><th>Descripción</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;

  return layout(`Catálogo (${rows.length} productos)`, tenant, body);
}

export async function renderPedidosPage(tenantId: string): Promise<string | null> {
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    return null;
  }

  const rows = await withTenant(tenantId, async (client) => {
    const result = await client.query<PedidoRow>(
      `SELECT o.id, o.status, o.payment_method, o.delivery_method, o.total, o.created_at,
              c.phone_number, c.name AS customer_name,
              COALESCE(
                json_agg(json_build_object('name', p.name, 'quantity', oi.quantity, 'unit_price', oi.unit_price))
                  FILTER (WHERE oi.id IS NOT NULL),
                '[]'
              ) AS items
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN products p ON p.id = oi.product_id
       GROUP BY o.id, o.status, o.payment_method, o.delivery_method, o.total, o.created_at, c.phone_number, c.name
       ORDER BY o.created_at DESC`,
    );
    return result.rows;
  });

  const tableRows = rows
    .map((row) => {
      const items = row.items
        .map(
          (item) =>
            `<li>${item.quantity}× ${escapeHtml(item.name)} (${formatCOP(item.unit_price)})</li>`,
        )
        .join("");
      return `<tr>
        <td>${escapeHtml(row.customer_name ?? row.phone_number)}</td>
        <td><ul class="items">${items}</ul></td>
        <td>${escapeHtml(row.status)}</td>
        <td>${escapeHtml(row.payment_method)}</td>
        <td>${escapeHtml(row.delivery_method)}</td>
        <td>${formatCOP(row.total)}</td>
        <td>${escapeHtml(String(row.created_at))}</td>
      </tr>`;
    })
    .join("\n");

  const body = `<table>
    <thead><tr><th>Cliente</th><th>Items</th><th>Estado</th><th>Pago</th><th>Entrega</th><th>Total</th><th>Fecha</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;

  return layout(`Pedidos (${rows.length})`, tenant, body);
}
