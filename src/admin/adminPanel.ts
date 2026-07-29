import { escapeHtml } from "../advisor/handoffView.js";
import { listTenants } from "../shared/db/tenantsDirectory.js";
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

function layout(title: string, tenantId: string | null, body: string): string {
  const nav = tenantId
    ? `<nav>
        <a href="/admin">Tenants</a> ·
        <a href="/admin/${tenantId}/productos">Catálogo</a> ·
        <a href="/admin/${tenantId}/pedidos">Pedidos</a>
      </nav>`
    : "";

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>ForMotos — ${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1000px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    nav { margin-bottom: 1.5rem; font-size: 0.9rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #ddd; padding: 0.5rem; text-align: left; vertical-align: top; font-size: 0.85rem; }
    img.thumb { width: 72px; height: 54px; object-fit: cover; border-radius: 4px; }
    .stock-cero { color: #b00020; font-weight: 600; }
    ul.items { margin: 0; padding-left: 1rem; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${nav}
  ${body}
</body>
</html>`;
}

export async function renderTenantsPage(): Promise<string> {
  const tenants = await listTenants();
  const items = tenants
    .map((tenant) => `<li><a href="/admin/${tenant.id}/productos">${escapeHtml(tenant.name)}</a></li>`)
    .join("\n");
  return layout("Tenants", null, `<ul>${items}</ul>`);
}

export async function renderProductosPage(tenantId: string): Promise<string> {
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

  return layout(`Catálogo (${rows.length} productos)`, tenantId, body);
}

export async function renderPedidosPage(tenantId: string): Promise<string> {
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

  return layout(`Pedidos (${rows.length})`, tenantId, body);
}
