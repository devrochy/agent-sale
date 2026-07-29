import { escapeHtml, renderMessageBody, type MessageRow } from "../advisor/handoffView.js";
import { env } from "../config/env.js";
import { getTenant, listTenants, type TenantSummary } from "../shared/db/tenantsDirectory.js";
import { withTenant } from "../shared/db/withTenant.js";

/**
 * Panel interno de solo lectura (ver docs de Fase 8/9/11): no hay sistema
 * de login en el proyecto, la protección la da Basic Auth en
 * src/gateway/server.ts. Sirve para operar/depurar el piloto — no es un
 * dashboard de cliente final.
 *
 * Sistema visual (Fase 11.1, ver docs/fase-11-panel-admin-dashboard/
 * overview-kpis.md): tablero de instrumentos de moto — dos temas (día
 * claro / noche oscura vía prefers-color-scheme), tipografía Oxanium +
 * IBM Plex Sans + IBM Plex Mono vía Google Fonts (mismo criterio de CDN
 * sin build step que htmx/Alpine en ADR-014), sin dependencias nuevas en
 * package.json.
 */

const FONT_LINK_HREF =
  "https://fonts.googleapis.com/css2?family=Oxanium:wght@600;700;800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap";

const FASE0_META_RESUELTO_SIN_HUMANO = 60; // docs/fase-0-descubrimiento.md, criterio de éxito

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

/** Fecha/hora en horario de Bogotá, sin importar el TZ del servidor. */
function formatFecha(value: string): string {
  const formatted = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
  return formatted.replace(",", " ·");
}

function formatRelativo(value: string): string {
  const diffMin = Math.floor((Date.now() - new Date(value).getTime()) / 60000);
  if (diffMin < 1) return "ahora";
  if (diffMin < 60) return `hace ${diffMin} min`;
  const horas = Math.floor(diffMin / 60);
  if (horas < 24) return `hace ${horas} h`;
  return `hace ${Math.floor(horas / 24)} d`;
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n");
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function brandName(tenant: TenantSummary): string {
  return tenant.display_name ?? tenant.name;
}

const ICON_PRODUCTOS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5.2 8 2l6 3.2v5.6L8 14 2 10.8V5.2Z"/><path d="M2 5.2 8 8l6-2.8"/><path d="M8 8v6"/></svg>';

const ICON_PEDIDOS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2h8v11.5l-1.5-1-1.5 1-1.5-1-1.5 1-1.5-1-1.5 1V2Z"/><path d="M6 5.5h4M6 8h4M6 10.5h2.5"/></svg>';

const ICON_RESUMEN =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.3 11.5a5.7 5.7 0 1 1 11.4 0"/><path d="M8 11.5 10.4 6.8"/><circle cx="8" cy="11.5" r="0.9" fill="currentColor" stroke="none"/></svg>';

const ICON_CONVERSACIONES =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.6h12v7.3H6.6L3.6 13.4v-2.5H2V3.6Z"/><path d="M5 6.6h6M5 8.6h3.5"/></svg>';

const ICON_LEADS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="5.1" r="2.5"/><path d="M2.6 13.4c.8-2.9 2.7-4.3 5.4-4.3s4.6 1.4 5.4 4.3"/></svg>';

const ICON_TICKETS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6.4V4.7c0-.4.3-.7.7-.7h10.6c.4 0 .7.3.7.7v1.7a1.2 1.2 0 0 0 0 2.4v1.7c0 .4-.3.7-.7.7H2.7a.7.7 0 0 1-.7-.7V8.8a1.2 1.2 0 0 0 0-2.4Z"/><path d="M6.2 4v8" stroke-dasharray="1.3 1.3"/></svg>';

const ICON_FLUJO =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="2.8" cy="2.8" r="1.5"/><circle cx="2.8" cy="13.2" r="1.5"/><circle cx="12.6" cy="8" r="1.7"/><path d="M4.2 3.5 11 7.2M4.2 12.5 11 8.8"/></svg>';

const ICON_CONEXIONES =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.3 2v3.2M10.7 2v3.2M3.8 5.2h8.4v2.7a4.2 4.2 0 0 1-8.4 0V5.2Z"/><path d="M8 12v2.4"/></svg>';

type ActiveSection =
  | "resumen"
  | "conversaciones"
  | "leads"
  | "tickets"
  | "flujo"
  | "conexiones"
  | "productos"
  | "pedidos"
  | null;

const ICON_COLLAPSE =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3 6 8l4 5"/></svg>';

function navRail(tenant: TenantSummary, active: ActiveSection): string {
  const item = (
    href: string,
    label: string,
    key: ActiveSection,
    icon?: string,
  ): string => {
    const isActive = key === active;
    const dot = icon ? `<span class="navicon">${icon}</span>` : '<span class="dot"></span>';
    return `<li><a class="navitem${isActive ? " navitem--active" : ""}" href="${href}"${isActive ? ' aria-current="page"' : ""} title="${escapeHtml(label)}">${dot}<span class="navitem__label">${escapeHtml(label)}</span></a></li>`;
  };

  const canal = tenant.whatsapp_number ? `WhatsApp configurado` : `Sin canal configurado`;

  return `<aside class="rail">
    <div class="rail__resize" data-rail-resize aria-hidden="true"></div>
    <div class="rail__top">
      <div class="brand">
        <span class="brand__mark">${escapeHtml(brandName(tenant).toUpperCase())}</span>
        <span class="brand__role">Panel</span>
      </div>
      <button type="button" class="rail__toggle" data-rail-toggle aria-label="Contraer u expandir el menú" title="Contraer u expandir el menú">${ICON_COLLAPSE}</button>
    </div>
    <nav class="rail__groups" aria-label="Secciones del panel">
      <div class="navgroup">
        <p class="navgroup__label">Panel</p>
        <ul class="navgroup__items">
          ${item(`/admin/${tenant.id}`, "Resumen", "resumen", ICON_RESUMEN)}
          ${item(`/admin/${tenant.id}/conversaciones`, "Conversaciones", "conversaciones", ICON_CONVERSACIONES)}
          ${item(`/admin/${tenant.id}/leads`, "Leads", "leads", ICON_LEADS)}
          ${item(`/admin/${tenant.id}/tickets`, "Tickets", "tickets", ICON_TICKETS)}
        </ul>
      </div>
      <div class="laneline"></div>
      <div class="navgroup">
        <p class="navgroup__label">Agente</p>
        <ul class="navgroup__items">
          ${item(`/admin/${tenant.id}/flujo`, "Flujo", "flujo", ICON_FLUJO)}
          ${item(`/admin/${tenant.id}/conexiones`, "Conexiones", "conexiones", ICON_CONEXIONES)}
        </ul>
      </div>
      <div class="laneline"></div>
      <div class="navgroup">
        <p class="navgroup__label">Catálogo</p>
        <ul class="navgroup__items">
          ${item(`/admin/${tenant.id}/productos`, "Productos", "productos", ICON_PRODUCTOS)}
          ${item(`/admin/${tenant.id}/pedidos`, "Pedidos", "pedidos", ICON_PEDIDOS)}
        </ul>
      </div>
    </nav>
    <div class="rail__status">
      <span class="pulse" aria-hidden="true"></span>
      <span class="navitem__label">${escapeHtml(canal)}</span>
    </div>
  </aside>`;
}

function layout(
  title: string,
  tenant: TenantSummary | null,
  body: string,
  active: ActiveSection = null,
): string {
  const heading = tenant ? `${brandName(tenant)} — ${title}` : title;
  const rail = tenant ? navRail(tenant, active) : "";

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(heading)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="${FONT_LINK_HREF}" rel="stylesheet">
  <style>
${STYLE_BLOCK}
  </style>
</head>
<body>
  <div class="shell${tenant ? "" : " shell--bare"}">
    ${rail}
    <main>
      ${body}
    </main>
  </div>
  <script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

const STYLE_BLOCK = `
:root {
  color-scheme: light dark;
  --bg: #EDF0F3;
  --bg-grid: #E1E6EA;
  --panel: #FFFFFF;
  --panel-inset: #F4F6F8;
  --border: #D8DFE4;
  --border-strong: #C3CCD3;
  --ink: #14181D;
  --ink-muted: #5B6570;
  --ink-faint: #889198;
  --ignition: #9C6108;
  --ignition-glow: #C9820F;
  --chrome: #0F6B7A;
  --chrome-soft: rgba(15, 107, 122, 0.12);
  --redline: #B4362A;
  --redline-soft: rgba(180, 54, 42, 0.1);
  --go: #2E7D4F;
  --go-soft: rgba(46, 125, 79, 0.1);
  --shadow: 0 1px 2px rgba(20, 24, 29, 0.04), 0 8px 24px rgba(20, 24, 29, 0.06);
  --font-display: "Oxanium", ui-monospace, monospace;
  --font-body: "IBM Plex Sans", -apple-system, "Segoe UI", sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171C; --bg-grid: #1A1E24; --panel: #1B1F26; --panel-inset: #21262E;
    --border: #2B313A; --border-strong: #3A424D; --ink: #F1EEE6; --ink-muted: #9BA3AD; --ink-faint: #6B727C;
    --ignition: #E8A33D; --ignition-glow: #FFC875; --chrome: #5FC7D9; --chrome-soft: rgba(95,199,217,0.14);
    --redline: #FF6B5E; --redline-soft: rgba(255,107,94,0.14); --go: #46C97F; --go-soft: rgba(70,201,127,0.14);
    --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 12px 32px rgba(0,0,0,0.35);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  background-image: radial-gradient(var(--bg-grid) 1px, transparent 1px);
  background-size: 22px 22px;
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
}
a { color: inherit; }
h1, h2 { text-wrap: balance; margin: 0; }
:focus-visible { outline: 2px solid var(--chrome); outline-offset: 2px; border-radius: 3px; }
::selection { background: var(--chrome-soft); }
.tabular { font-variant-numeric: tabular-nums; }
:root { --rail-width: 264px; }
.shell { display: grid; grid-template-columns: var(--rail-width) 1fr; min-height: 100vh; }
.shell--bare { grid-template-columns: 1fr; }
@media (max-width: 860px) { .shell { grid-template-columns: 1fr; } }
body.rail-collapsed .shell { grid-template-columns: 60px 1fr; }
.rail {
  border-right: 1px solid var(--border);
  padding: 22px 14px 18px;
  display: flex; flex-direction: column; gap: 26px;
  position: sticky; top: 0; height: 100vh; overflow-x: hidden; overflow-y: auto;
}
.rail__resize { position: absolute; top: 0; right: -3px; width: 6px; height: 100%; cursor: col-resize; z-index: 3; }
.rail__resize:hover, .rail__resize.dragging { background: var(--chrome-soft); }
body.rail-collapsed .rail__resize { display: none; }
.rail__top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.rail__toggle { flex-shrink: 0; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-inset); color: var(--ink-muted); cursor: pointer; }
.rail__toggle:hover { color: var(--ink); border-color: var(--border-strong); }
.rail__toggle svg { width: 13px; height: 13px; transition: transform 160ms ease; }
body.rail-collapsed .rail__toggle svg { transform: rotate(180deg); }
.brand { display: flex; align-items: baseline; gap: 9px; white-space: nowrap; overflow: hidden; }
.brand__mark { font-family: var(--font-display); font-weight: 800; font-size: 18px; letter-spacing: 0.01em; }
.brand__role { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-faint); border-left: 1px solid var(--border-strong); padding-left: 9px; }
.rail__groups { display: flex; flex-direction: column; gap: 22px; flex: 1; }
.navgroup__label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-faint); margin: 0 0 8px 10px; white-space: nowrap; }
.navgroup__items { list-style: none; margin: 0; padding: 0; }
.navitem { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 7px; font-size: 13.5px; font-weight: 500; color: var(--ink-muted); text-decoration: none; cursor: pointer; white-space: nowrap; }
.navitem:hover { background: var(--panel-inset); color: var(--ink); }
.navitem .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-faint); flex-shrink: 0; }
.navitem .navicon { width: 16px; height: 16px; flex-shrink: 0; color: var(--ink-faint); }
.navitem__label { display: flex; align-items: center; gap: 10px; overflow: hidden; }
.navitem--active { background: var(--panel-inset); color: var(--ink); box-shadow: inset 2px 0 0 var(--ignition); }
.navitem--active .dot { background: var(--ignition); }
.navitem--active .navicon { color: var(--ignition); }
.laneline { height: 0; border-top: 1px dashed var(--border); margin: 2px 4px; }
.rail__status { display: flex; align-items: center; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-inset); font-size: 12px; color: var(--ink-muted); white-space: nowrap; overflow: hidden; }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--chrome); box-shadow: 0 0 0 0 var(--chrome-soft); animation: pulse 2.4s ease-out infinite; flex-shrink: 0; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 var(--chrome-soft); } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
@media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
body.rail-collapsed .navitem__label,
body.rail-collapsed .brand__role,
body.rail-collapsed .navgroup__label { display: none; }
body.rail-collapsed .navitem { justify-content: center; }
body.rail-collapsed .rail__status span:not(.pulse) { display: none; }
/* Este override tiene que ir DESPUÉS de las reglas base de .rail__groups/
   .rail__status de arriba: con la misma especificidad (una sola clase),
   gana la que aparece última en la hoja de estilos — si este bloque
   quedara antes (como pasaba originalmente), la regla base
   ".rail__groups { display: flex }" lo pisaba silenciosamente y el menú
   nunca se colapsaba en mobile/tablet, aunque el resto de .rail sí
   cambiaba (flex-direction/position), dejando la lista completa de
   secciones apilada encima del contenido. */
@media (max-width: 860px) {
  .rail { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--border); flex-direction: row; flex-wrap: wrap; align-items: center; overflow-x: visible; gap: 18px; }
  /* Oculto por defecto en mobile/tablet — data-rail-toggle lo abre como
     desplegable (body.rail-mobile-open) en vez de colapsar a solo
     iconos (eso es el comportamiento de escritorio, ver rail-collapsed):
     sin este panel no había NINGUNA forma de llegar a Productos/Pedidos/
     Leads/etc. desde un teléfono, solo se veía la página actual. */
  .rail__groups { display: none; flex-basis: 100%; order: 3; padding-top: 14px; border-top: 1px dashed var(--border); }
  body.rail-mobile-open .rail__groups { display: flex; }
  .rail__status { margin-left: auto; }
  .rail__resize { display: none; }
  body.rail-mobile-open .rail__toggle svg { transform: rotate(90deg); }
}
main { padding: 34px 40px 60px; width: 100%; min-width: 0; }
.shell--bare main { max-width: 640px; margin: 0 auto; }
@media (max-width: 860px) { main { padding: 24px 18px 48px; } }
@media (max-width: 560px) { main { padding: 18px 14px 40px; } }
.pagehead { margin-bottom: 28px; }
.pagehead__row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12.5px; font-weight: 600; padding: 9px 15px; border-radius: 7px; border: 1px solid var(--border); background: var(--panel); color: var(--ink); text-decoration: none; cursor: pointer; white-space: nowrap; flex-shrink: 0; }
.btn:hover { border-color: var(--border-strong); background: var(--panel-inset); }
.linklike { color: var(--chrome); text-decoration: none; font-weight: 600; font-size: 12.5px; white-space: nowrap; }
.linklike:hover { text-decoration: underline; }
.eyebrow { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--chrome); margin: 0 0 6px; }
.pagehead h1 { font-family: var(--font-display); font-weight: 700; font-size: 28px; letter-spacing: -0.01em; }
.pagehead p { margin: 8px 0 0; color: var(--ink-muted); font-size: 14px; }
.kpirow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 34px; }
@media (max-width: 640px) { .kpirow { grid-template-columns: 1fr; } }
.kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px 20px; box-shadow: var(--shadow); position: relative; overflow: hidden; transition: box-shadow 220ms ease, transform 220ms ease; }
.kpi:hover { transform: translateY(-1px); box-shadow: var(--shadow), 0 0 0 1px var(--border-strong); }
.kpi.ignite { box-shadow: var(--shadow), 0 0 0 1px var(--ignition-glow), 0 0 22px -6px var(--ignition-glow); }
.kpi__label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); font-weight: 600; }
.kpi__figure { display: flex; align-items: center; justify-content: space-between; gap: 4px; margin-top: 8px; }
.kpi__number { font-family: var(--font-display); font-weight: 800; font-size: 36px; letter-spacing: -0.01em; color: var(--ink); }
.kpi__foot { margin-top: 12px; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-muted); flex-wrap: wrap; }
.trend { display: inline-flex; align-items: center; gap: 3px; font-family: var(--font-mono); font-weight: 600; font-size: 12px; padding: 2px 6px; border-radius: 20px; }
.trend--up { color: var(--go); background: var(--go-soft); }
.trend--down { color: var(--redline); background: var(--redline-soft); }
.trend svg { width: 9px; height: 9px; }
.kpi__arc-wrap { position: relative; width: 50px; height: 50px; flex-shrink: 0; }
.kpi__arc-wrap svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.kpi__arc-bg { fill: none; stroke: var(--border); stroke-width: 5; }
.kpi__arc-fill { fill: none; stroke: var(--go); stroke-width: 5; stroke-linecap: round; stroke-dasharray: 132; stroke-dashoffset: 132; transition: stroke-dashoffset 1100ms cubic-bezier(.2,.8,.2,1) 200ms; }
.kpi__arc-fill.below-target { stroke: var(--redline); }
section.block { margin-bottom: 34px; }
.blockhead { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 14px; gap: 12px; }
.blockhead h2 { font-family: var(--font-display); font-weight: 700; font-size: 17px; }
.blockhead .hint { font-size: 12px; color: var(--ink-faint); font-family: var(--font-mono); }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); }
.chartpanel { padding: 18px 20px 8px; }
.chart-wrap { position: relative; }
.chart-wrap svg { width: 100%; height: auto; display: block; overflow: visible; }
.chart-grid line { stroke: var(--border); stroke-width: 1; stroke-dasharray: 2 4; }
.chart-area { fill: var(--ignition); opacity: 0.12; }
.chart-line { fill: none; stroke: var(--ignition); stroke-width: 2.25; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 620; stroke-dashoffset: 620; transition: stroke-dashoffset 1400ms cubic-bezier(.16,.8,.24,1) 120ms; }
.chart-point { fill: var(--panel); stroke: var(--ignition); stroke-width: 2.25; }
.chart-point--peak { fill: var(--ignition); }
.chart-daylabel { font-family: var(--font-mono); font-size: 10px; fill: var(--ink-faint); text-anchor: middle; }
.chart-peaklabel { font-family: var(--font-mono); font-weight: 600; font-size: 12px; fill: var(--ink); text-anchor: middle; }
.chart-hit { fill: transparent; cursor: crosshair; }
.chart-crosshair { stroke: var(--border-strong); stroke-width: 1; opacity: 0; transition: opacity 120ms ease; }
.chart-crosshair.visible { opacity: 1; }
.chart-tooltip { position: absolute; pointer-events: none; background: var(--ink); color: var(--bg); font-family: var(--font-mono); font-size: 11px; padding: 5px 8px; border-radius: 6px; white-space: nowrap; opacity: 0; transform: translate(-50%, -100%); transition: opacity 120ms ease; z-index: 5; }
.chart-tooltip.visible { opacity: 1; }
.chart-empty { padding: 40px 20px; text-align: center; color: var(--ink-faint); font-size: 13px; }
.convlist { list-style: none; margin: 0; padding: 0; }
.convrow { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 14px; align-items: baseline; padding: 13px 20px; border-bottom: 1px solid var(--border); }
.convrow:last-child { border-bottom: none; }
.convrow__who { font-weight: 600; font-size: 13.5px; grid-column: 1; }
.convrow__msg { grid-column: 1 / -1; color: var(--ink-muted); font-size: 13.5px; margin-top: 1px; }
.convrow__meta { grid-column: 3; display: flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 11px; color: var(--ink-faint); white-space: nowrap; }
.chip { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.04em; padding: 2px 7px; border-radius: 20px; font-weight: 600; }
.chip--go { color: var(--go); background: var(--go-soft); }
.chip--redline { color: var(--redline); background: var(--redline-soft); }
.chip--amber { color: var(--ignition); background: rgba(156, 97, 8, 0.12); }
@media (prefers-color-scheme: dark) { .chip--amber { background: rgba(232, 163, 61, 0.16); } }
.chip--muted { color: var(--ink-faint); background: var(--panel-inset); }
@media (max-width: 560px) { .convrow { grid-template-columns: 1fr; } .convrow__meta { grid-column: 1; justify-content: flex-start; } }
.empty { padding: 28px 20px; color: var(--ink-faint); font-size: 13px; }
table { border-collapse: collapse; width: 100%; min-width: 720px; table-layout: fixed; font-size: 13.5px; }
th { text-align: left; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); font-weight: 600; padding: 10px 16px; border-bottom: 1px solid var(--border); position: relative; }
td { padding: 11px 16px; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: break-word; }
tr:last-child td { border-bottom: none; }
tr[data-search] { display: none; }
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
img.thumb { width: 56px; height: 42px; object-fit: cover; border-radius: 5px; display: block; }
.stock-cero { color: var(--redline); font-weight: 600; }
ul.items { margin: 0; padding-left: 16px; }
.tablewrap { overflow-x: auto; }
.colresize { position: absolute; top: 0; right: 0; width: 6px; height: 100%; cursor: col-resize; }
.colresize:hover, .colresize.dragging { background: var(--chrome-soft); }
table.resizing { cursor: col-resize; user-select: none; }
.tabletools { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--border); }
.searchbox { flex: 1; max-width: 320px; font: inherit; font-size: 13px; background: var(--panel-inset); border: 1px solid var(--border); border-radius: 7px; padding: 7px 11px; color: var(--ink); }
.searchbox::placeholder { color: var(--ink-faint); }
.searchbox:focus-visible { outline: 2px solid var(--chrome); outline-offset: 1px; }
.tabletools .hint { font-family: var(--font-mono); }
.pager { display: flex; align-items: center; justify-content: flex-end; gap: 12px; padding: 12px 20px; border-top: 1px solid var(--border); font-size: 12px; color: var(--ink-muted); }
.pager button { font: inherit; background: var(--panel-inset); border: 1px solid var(--border); border-radius: 6px; width: 26px; height: 26px; color: var(--ink); cursor: pointer; }
.pager button:disabled { opacity: 0.35; cursor: default; }
.pager button:not(:disabled):hover { border-color: var(--border-strong); }
.flow { display: flex; flex-direction: column; align-items: center; gap: 0; max-width: 640px; }
.flowline { width: 2px; height: 26px; background: repeating-linear-gradient(var(--border-strong), var(--border-strong) 4px, transparent 4px, transparent 8px); }
.flownode { width: 100%; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); padding: 16px 20px; text-align: center; }
.flownode--core { text-align: left; }
.flownode__eyebrow { display: block; font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--chrome); margin-bottom: 4px; }
.flownode--core .flownode__eyebrow { text-align: center; }
.flownode__title { font-family: var(--font-display); font-weight: 700; font-size: 15px; }
.flownode--core .flownode__title { display: block; text-align: center; margin-bottom: 14px; }
.flowsub { display: flex; flex-direction: column; gap: 10px; border-top: 1px dashed var(--border); padding-top: 14px; }
.flowsub__row { display: flex; align-items: baseline; gap: 12px; font-size: 13px; }
.flowsub__row--tools { align-items: flex-start; }
.flowsub__label { flex-shrink: 0; width: 76px; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-faint); font-weight: 600; }
.toolgrid { display: flex; flex-wrap: wrap; gap: 7px; }
.toolpill { display: inline-flex; align-items: center; gap: 7px; padding: 5px 10px; border-radius: 20px; background: var(--panel-inset); border: 1px solid var(--border); font-size: 12px; }
.toolpill__count { font-family: var(--font-mono); font-weight: 700; color: var(--ignition); }
.flowfoot { margin-top: 14px; font-size: 12px; color: var(--ink-faint); font-family: var(--font-mono); }
.connection { padding: 22px 24px; max-width: 640px; }
.connection__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
.connection__head h2 { font-family: var(--font-display); font-size: 18px; font-weight: 700; }
.connection__badge { display: inline-flex; align-items: center; gap: 7px; font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 600; padding: 4px 10px; border-radius: 20px; }
.connection__badge--on { color: var(--go); background: var(--go-soft); }
.connection__badge--on .pulse { background: var(--go); }
.connection__badge--off { color: var(--redline); background: var(--redline-soft); }
.connection__meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin: 18px 0; padding: 14px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.connection__meta dt { font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-faint); margin-bottom: 4px; }
.connection__meta dd { margin: 0; font-size: 13.5px; }
.connection__webhook label { display: block; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-faint); margin-bottom: 8px; font-weight: 600; }
.copyrow { display: flex; align-items: center; gap: 10px; }
.copyrow code { flex: 1; background: var(--panel-inset); border: 1px solid var(--border); border-radius: 7px; padding: 9px 12px; font-size: 12.5px; overflow-x: auto; white-space: nowrap; }
.connection__missing { margin: 16px 0 0; padding: 10px 14px; border-radius: 8px; background: var(--redline-soft); color: var(--redline); font-size: 12.5px; }
.tenantlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.tenantlist a { display: block; padding: 14px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); font-weight: 600; box-shadow: var(--shadow); }
.tenantlist a:hover { border-color: var(--border-strong); }
.convtabs { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
.convtabs a { font-family: var(--font-mono); font-size: 11.5px; letter-spacing: 0.06em; text-transform: uppercase; padding: 6px 13px; border-radius: 20px; color: var(--ink-muted); text-decoration: none; border: 1px solid transparent; }
.convtabs a:hover { color: var(--ink); }
.convtabs a.tab--active { background: var(--panel-inset); color: var(--ink); border-color: var(--border-strong); font-weight: 600; }
.inbox { display: grid; grid-template-columns: 320px 1fr; gap: 16px; align-items: start; }
@media (max-width: 860px) { .inbox { grid-template-columns: 1fr; } }
.inbox__list { max-height: 74vh; overflow-y: auto; }
.convitems { list-style: none; margin: 0; padding: 0; }
.convitem { display: block; padding: 12px 16px; border-bottom: 1px solid var(--border); text-decoration: none; color: inherit; }
.convitem:last-child { border-bottom: none; }
.convitem:hover { background: var(--panel-inset); }
.convitem--active { background: var(--chrome-soft); box-shadow: inset 2px 0 0 var(--chrome); }
.convitem__row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.convitem__who { font-weight: 600; font-size: 13.5px; }
.convitem__time { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-faint); white-space: nowrap; flex-shrink: 0; }
.convitem__msg { display: block; margin-top: 3px; font-size: 12.5px; color: var(--ink-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.convitem__chips { display: flex; gap: 4px; margin-top: 6px; }
.inbox__detail { min-height: 74vh; display: flex; flex-direction: column; }
.thread__head { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.thread__head h2 { font-family: var(--font-display); font-size: 16px; font-weight: 700; }
.thread__meta { font-family: var(--font-mono); font-size: 11px; color: var(--ink-faint); white-space: nowrap; }
.thread__body { flex: 1; overflow-y: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 10px; max-height: 64vh; }
.bubble { max-width: 72%; padding: 9px 13px; border-radius: 12px; font-size: 13.5px; line-height: 1.45; }
.bubble.inbound { align-self: flex-start; background: var(--panel-inset); border-bottom-left-radius: 4px; }
.bubble.outbound { align-self: flex-end; background: var(--chrome-soft); border-bottom-right-radius: 4px; }
.bubble .meta { display: block; margin-top: 4px; font-family: var(--font-mono); font-size: 10px; color: var(--ink-faint); }
.thread__empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--ink-faint); font-size: 13px; padding: 40px; text-align: center; }
`;

const CLIENT_SCRIPT = `
(function () {
  "use strict";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function easeOutBack(t) {
    var c1 = 1.4, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function animateCount(el) {
    var target = parseFloat(el.getAttribute("data-count-to"));
    var suffix = el.getAttribute("data-suffix") || "";
    if (reduced || !isFinite(target)) { el.textContent = target + suffix; return; }
    var start = performance.now();
    var duration = 900;
    function tick(now) {
      var t = Math.min(1, (now - start) / duration);
      var eased = t < 1 ? easeOutBack(t) : 1;
      el.textContent = Math.max(0, Math.round(target * eased)) + suffix;
      if (t < 1) requestAnimationFrame(tick); else el.textContent = target + suffix;
    }
    requestAnimationFrame(tick);
  }
  document.querySelectorAll("[data-count-to]").forEach(animateCount);

  document.querySelectorAll(".kpi").forEach(function (card, i) {
    if (reduced) return;
    setTimeout(function () {
      card.classList.add("ignite");
      setTimeout(function () { card.classList.remove("ignite"); }, 900);
    }, i * 90);
  });

  document.querySelectorAll(".kpi__arc-fill").forEach(function (arc) {
    var pct = parseFloat(arc.getAttribute("data-arc"));
    var circumference = 132;
    var finalOffset = circumference * (1 - pct / 100);
    if (reduced) { arc.style.strokeDashoffset = finalOffset; return; }
    arc.style.strokeDashoffset = circumference;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { arc.style.strokeDashoffset = finalOffset; });
    });
  });

  var chartData = null;
  var chartDataEl = document.getElementById("actividad-data");
  if (chartDataEl) {
    try { chartData = JSON.parse(chartDataEl.textContent); } catch (e) { chartData = null; }
  }
  var wrap = document.getElementById("chartWrap");
  if (wrap && chartData && chartData.length) {
    var data = chartData;
    var W = 900, H = 220, padL = 8, padR = 8, padT = 26, padB = 28;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var maxV = Math.max(1, Math.max.apply(null, data.map(function (d) { return d.valor; })));

    function x(i) { return padL + (i / (data.length - 1)) * plotW; }
    function y(v) { return padT + plotH - (v / maxV) * plotH; }

    var linePts = data.map(function (d, i) { return x(i) + "," + y(d.valor); }).join(" L ");
    var lineD = "M " + linePts;
    var areaD = lineD + " L " + x(data.length - 1) + "," + (padT + plotH) + " L " + x(0) + "," + (padT + plotH) + " Z";
    var peakIdx = data.reduce(function (best, d, i) { return d.valor > data[best].valor ? i : best; }, 0);

    var gridLines = "";
    for (var g = 0; g <= 3; g++) {
      var gy = padT + (plotH / 3) * g;
      gridLines += '<line class="chart-grid" x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '"></line>';
    }
    var dayLabels = data.map(function (d, i) {
      return '<text class="chart-daylabel" x="' + x(i) + '" y="' + (H - 6) + '">' + d.label + "</text>";
    }).join("");
    var points = data.map(function (d, i) {
      var cls = "chart-point" + (i === peakIdx ? " chart-point--peak" : "");
      return '<circle class="' + cls + '" cx="' + x(i) + '" cy="' + y(d.valor) + '" r="' + (i === peakIdx ? 4 : 3) + '"></circle>';
    }).join("");
    var peakLabel = '<text class="chart-peaklabel" x="' + x(peakIdx) + '" y="' + (y(data[peakIdx].valor) - 12) + '">' + data[peakIdx].valor + "</text>";
    var hitCols = data.map(function (d, i) {
      var cw = plotW / data.length, cx0 = padL + i * cw;
      return '<rect class="chart-hit" data-i="' + i + '" x="' + cx0 + '" y="0" width="' + cw + '" height="' + H + '"></rect>';
    }).join("");

    wrap.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="Mensajes por dia, ultimos 7 dias">'
      + gridLines + '<path class="chart-area" d="' + areaD + '"></path>'
      + '<path class="chart-line" id="chartLine" d="' + lineD + '"></path>'
      + points + peakLabel + dayLabels
      + '<line class="chart-crosshair" id="crosshair" x1="0" y1="' + padT + '" x2="0" y2="' + (padT + plotH) + '"></line>'
      + hitCols + "</svg>";

    var tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    wrap.appendChild(tooltip);
    var svgEl = wrap.querySelector("svg");
    var crosshair = wrap.querySelector("#crosshair");

    wrap.addEventListener("mousemove", function (evt) {
      var rect = svgEl.getBoundingClientRect();
      var relX = ((evt.clientX - rect.left) / rect.width) * W;
      var i = Math.max(0, Math.min(data.length - 1, Math.round(((relX - padL) / plotW) * (data.length - 1))));
      var d = data[i], px = x(i), py = y(d.valor);
      crosshair.setAttribute("x1", px); crosshair.setAttribute("x2", px);
      crosshair.classList.add("visible");
      tooltip.style.left = (px * (rect.width / W)) + "px";
      tooltip.style.top = (py * (rect.height / H) - 10) + "px";
      tooltip.innerHTML = d.label + " &nbsp; <b>" + d.valor + "</b> msj";
      tooltip.classList.add("visible");
    });
    wrap.addEventListener("mouseleave", function () {
      crosshair.classList.remove("visible");
      tooltip.classList.remove("visible");
    });

    if (!reduced) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { document.getElementById("chartLine").style.strokeDashoffset = "0"; });
      });
    } else {
      document.getElementById("chartLine").style.transition = "none";
      document.getElementById("chartLine").style.strokeDashoffset = "0";
    }
  }

  /* ---------- riel: colapsar y redimensionar (persistido en localStorage) ---------- */
  var rail = document.querySelector(".rail");
  if (rail) {
    var WIDTH_KEY = "panelRailWidth";
    var COLLAPSED_KEY = "panelRailCollapsed";
    var savedWidth = localStorage.getItem(WIDTH_KEY);
    if (savedWidth) document.documentElement.style.setProperty("--rail-width", savedWidth + "px");
    if (localStorage.getItem(COLLAPSED_KEY) === "1") document.body.classList.add("rail-collapsed");

    // rail-collapsed es un concepto solo de escritorio (icono-únicamente,
    // con ancho de riel de sobra) — varias reglas CSS le dan más
    // especificidad que el override responsive (ej. "body.rail-collapsed
    // .shell" le gana a ".shell" dentro del @media, sin importar el
    // orden), así que si esa clase queda puesta en mobile/tablet (por
    // localStorage de una sesión de escritorio previa, o por redimensionar
    // la ventana en vivo) el layout se rompe: la columna del riel se
    // fuerza a 60px con el contenido del menú completo desbordando hacia
    // abajo. Se quita explícito apenas el viewport entra en el breakpoint
    // móvil, tanto al cargar como al redimensionar.
    function clearDesktopCollapseOnMobile() {
      if (window.matchMedia("(max-width: 860px)").matches) {
        document.body.classList.remove("rail-collapsed");
      }
    }
    clearDesktopCollapseOnMobile();
    window.addEventListener("resize", clearDesktopCollapseOnMobile);

    var toggleBtn = document.querySelector("[data-rail-toggle]");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", function () {
        // En mobile/tablet el mismo botón abre/cierra el desplegable de
        // secciones (rail-mobile-open) en vez de colapsar a solo iconos
        // (rail-collapsed es el comportamiento de escritorio, con ancho
        // de riel de sobra para eso) — no se persiste en localStorage,
        // se resetea cerrado en cada carga de página.
        if (window.matchMedia("(max-width: 860px)").matches) {
          document.body.classList.toggle("rail-mobile-open");
          return;
        }
        document.body.classList.toggle("rail-collapsed");
        localStorage.setItem(COLLAPSED_KEY, document.body.classList.contains("rail-collapsed") ? "1" : "0");
      });
    }

    var resizeHandle = document.querySelector("[data-rail-resize]");
    if (resizeHandle) {
      resizeHandle.addEventListener("mousedown", function (evt) {
        if (document.body.classList.contains("rail-collapsed")) return;
        evt.preventDefault();
        resizeHandle.classList.add("dragging");
        function onMove(moveEvt) {
          var w = Math.min(420, Math.max(200, moveEvt.clientX));
          document.documentElement.style.setProperty("--rail-width", w + "px");
        }
        function onUp() {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          resizeHandle.classList.remove("dragging");
          var current = getComputedStyle(document.documentElement).getPropertyValue("--rail-width");
          localStorage.setItem(WIDTH_KEY, parseInt(current, 10));
        }
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    }
  }

  /* ---------- tablas: búsqueda + paginado en el cliente ---------- */
  document.querySelectorAll("[data-table]").forEach(function (wrap) {
    var pageSize = parseInt(wrap.getAttribute("data-page-size"), 10) || 15;
    var tbody = wrap.querySelector("tbody");
    var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr[data-search]"));
    var searchInput = wrap.querySelector("[data-table-search]");
    var countEl = wrap.querySelector("[data-table-count]");
    var pagerEl = wrap.querySelector("[data-table-pager]");
    var pageLabel = wrap.querySelector("[data-table-pagelabel]");
    var prevBtn = wrap.querySelector("[data-table-prev]");
    var nextBtn = wrap.querySelector("[data-table-next]");
    var page = 1;

    function apply() {
      var q = (searchInput.value || "").trim().toLowerCase();
      var matched = rows.filter(function (tr) {
        return !q || tr.getAttribute("data-search").indexOf(q) !== -1;
      });
      var pages = Math.max(1, Math.ceil(matched.length / pageSize));
      if (page > pages) page = pages;
      var start = (page - 1) * pageSize;
      rows.forEach(function (tr) { tr.style.display = "none"; });
      // "table-row" explícito, no "" — la hoja de estilos ya declara
      // tr[data-search] { display: none } por defecto (evita el parpadeo
      // de todas las filas antes de paginar); un style.display = "" no
      // anula esa regla, solo limpia un override inline previo.
      matched.slice(start, start + pageSize).forEach(function (tr) { tr.style.display = "table-row"; });
      if (countEl) countEl.textContent = matched.length;
      if (pageLabel) pageLabel.textContent = page + " / " + pages;
      if (prevBtn) prevBtn.disabled = page <= 1;
      if (nextBtn) nextBtn.disabled = page >= pages;
      if (pagerEl) pagerEl.style.display = pages > 1 ? "" : "none";
    }
    if (searchInput) {
      searchInput.addEventListener("input", function () { page = 1; apply(); });
    }
    if (prevBtn) prevBtn.addEventListener("click", function () { if (page > 1) { page--; apply(); } });
    if (nextBtn) nextBtn.addEventListener("click", function () { page++; apply(); });
    apply();
  });

  /* ---------- tablas: columnas redimensionables (persistido por tabla) ---------- */
  document.querySelectorAll("[data-resizable-table]").forEach(function (table) {
    var tableId = table.getAttribute("data-resizable-table");
    var cols = table.querySelectorAll("colgroup col");
    var ths = table.querySelectorAll("thead th");
    var storageKey = "panelTableCols:" + tableId;
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(storageKey) || "null"); } catch (e) { saved = null; }
    if (saved && saved.length === cols.length) {
      cols.forEach(function (col, i) { col.style.width = saved[i] + "px"; });
    }
    ths.forEach(function (th, i) {
      if (i === ths.length - 1) return;
      var handle = document.createElement("span");
      handle.className = "colresize";
      handle.setAttribute("aria-hidden", "true");
      th.appendChild(handle);
      handle.addEventListener("mousedown", function (evt) {
        evt.preventDefault();
        // Congela el ancho actual de TODAS las columnas en px antes de
        // arrastrar: si se deja alguna en %, table-layout:fixed reparte el
        // cambio entre esas columnas de forma impredecible (una lejana se
        // encoge en vez de solo la vecina). Así el arrastre se comporta
        // como en una hoja de cálculo — solo cambia la columna arrastrada,
        // el resto queda igual y la tabla crece/decrece dentro del scroll
        // horizontal de .tablewrap.
        ths.forEach(function (otherTh, j) {
          cols[j].style.width = Math.round(otherTh.getBoundingClientRect().width) + "px";
        });
        var startX = evt.clientX;
        var startWidth = th.getBoundingClientRect().width;
        table.classList.add("resizing");
        handle.classList.add("dragging");
        function onMove(moveEvt) {
          var w = Math.max(48, startWidth + (moveEvt.clientX - startX));
          cols[i].style.width = w + "px";
        }
        function onUp() {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          table.classList.remove("resizing");
          handle.classList.remove("dragging");
          var widths = Array.prototype.map.call(cols, function (c) {
            return Math.round(c.getBoundingClientRect().width);
          });
          localStorage.setItem(storageKey, JSON.stringify(widths));
        }
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    });
  });

  /* ---------- copiar al portapapeles (ej. URL de webhook en Conexiones) ---------- */
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      var original = btn.textContent;
      navigator.clipboard.writeText(text).then(
        function () {
          btn.textContent = "Copiado";
          setTimeout(function () { btn.textContent = original; }, 1500);
        },
        function () {
          btn.textContent = "No se pudo copiar";
          setTimeout(function () { btn.textContent = original; }, 1500);
        },
      );
    });
  });
})();
`;

export async function renderTenantsPage(): Promise<string> {
  const tenants = await listTenants();
  const items = tenants
    .map(
      (tenant) =>
        `<li><a href="/admin/${tenant.id}">${escapeHtml(brandName(tenant))}</a></li>`,
    )
    .join("\n");
  const body = `
    <div class="pagehead">
      <p class="eyebrow">agent-sale / admin</p>
      <h1>Tenants</h1>
    </div>
    <ul class="tenantlist">${items}</ul>
  `;
  return layout("Tenants", null, body);
}

interface OverviewKpiRow {
  mensajes_24h: string;
  mensajes_24h_prev: string;
  clientes_unicos_24h: string;
  clientes_unicos_24h_prev: string;
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
  has_order: boolean;
  has_open_handoff: boolean;
}

function trendChip(current: number, previous: number): string {
  if (previous === 0) {
    return current > 0
      ? '<span class="trend trend--up">nuevo</span>'
      : "";
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  const dir = pct >= 0 ? "up" : "down";
  const arrow =
    dir === "up"
      ? '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 8 L5 2 L9 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 2 L5 8 L9 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return `<span class="trend trend--${dir}">${arrow}${Math.abs(pct)}%</span>`;
}

/**
 * Home del tenant en el panel (ver docs/fase-11-panel-admin-dashboard/
 * overview-kpis.md, Fase 11.1).
 */
export async function renderOverviewPage(tenantId: string): Promise<string | null> {
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    return null;
  }

  const { kpis, resuelto, actividad, recientes } = await withTenant(tenantId, async (client) => {
    const kpisResult = await client.query<OverviewKpiRow>(
      `SELECT
        count(*) filter (where m.created_at >= now() - interval '24 hours') AS mensajes_24h,
        count(*) filter (where m.created_at >= now() - interval '48 hours' and m.created_at < now() - interval '24 hours') AS mensajes_24h_prev,
        count(DISTINCT conv.customer_id) filter (where m.created_at >= now() - interval '24 hours') AS clientes_unicos_24h,
        count(DISTINCT conv.customer_id) filter (where m.created_at >= now() - interval '48 hours' and m.created_at < now() - interval '24 hours') AS clientes_unicos_24h_prev
       FROM messages m
       JOIN conversations conv ON conv.id = m.conversation_id
       WHERE m.created_at >= now() - interval '48 hours'`,
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
      // como objeto Date, no string, y el cliente consume esto como JSON.
      `SELECT to_char(date_trunc('day', m.created_at), 'YYYY-MM-DD') AS dia, count(*) AS mensajes
       FROM messages m
       WHERE m.created_at >= now() - interval '7 days'
       GROUP BY 1
       ORDER BY 1`,
    );

    const recientesResult = await client.query<ConversacionRecienteRow>(
      `SELECT c.name AS customer_name, c.phone_number, m.content, m.created_at,
              exists(select 1 from orders o where o.conversation_id = conv.id) AS has_order,
              exists(select 1 from handoff_queue h where h.conversation_id = conv.id and h.status <> 'resuelto') AS has_open_handoff
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

  const actividadPorDia = new Map(actividad.map((row) => [row.dia, Number(row.mensajes)]));
  const dias = Array.from({ length: 7 }, (_, i) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - (6 - i));
    const iso = date.toISOString().slice(0, 10);
    const label = `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    return { label, valor: actividadPorDia.get(iso) ?? 0 };
  });

  const conversacionesHtml = recientes
    .map((row) => {
      let chip = "";
      if (row.has_order) chip = '<span class="chip chip--go">Pedido confirmado</span>';
      else if (row.has_open_handoff) chip = '<span class="chip chip--redline">Escalada</span>';
      return `<li class="convrow">
        <span class="convrow__who">${escapeHtml(row.customer_name ?? row.phone_number)}</span>
        <span class="convrow__meta">${chip}${formatRelativo(row.created_at)}</span>
        <span class="convrow__msg">${escapeHtml(row.content)}</span>
      </li>`;
    })
    .join("\n");

  const mensajes24h = Number(kpis.mensajes_24h);
  const mensajes24hPrev = Number(kpis.mensajes_24h_prev);
  const clientes24h = Number(kpis.clientes_unicos_24h);
  const clientes24hPrev = Number(kpis.clientes_unicos_24h_prev);

  const arcHtml =
    pctResueltoSinHumano === null
      ? ""
      : `<div class="kpi__arc-wrap">
          <svg viewBox="0 0 54 54" aria-hidden="true">
            <circle class="kpi__arc-bg" cx="27" cy="27" r="21"></circle>
            <circle class="kpi__arc-fill${pctResueltoSinHumano < FASE0_META_RESUELTO_SIN_HUMANO ? " below-target" : ""}" data-arc="${pctResueltoSinHumano}" cx="27" cy="27" r="21"></circle>
          </svg>
        </div>`;

  const body = `
    <div class="pagehead">
      <p class="eyebrow">Inicio / Resumen</p>
      <h1>Así va ${escapeHtml(brandName(tenant))} hoy</h1>
      <p>Lo que el agente resolvió solo, lo que preguntó la gente, y qué tan rápido respondió.</p>
    </div>

    <section class="kpirow" aria-label="Indicadores clave">
      <article class="kpi">
        <p class="kpi__label">Mensajes · 24 h</p>
        <div class="kpi__figure"><span class="kpi__number tabular" data-count-to="${mensajes24h}">0</span></div>
        <div class="kpi__foot">${trendChip(mensajes24h, mensajes24hPrev)}<span>vs. ayer (${mensajes24hPrev})</span></div>
      </article>
      <article class="kpi">
        <p class="kpi__label">Clientes únicos · 24 h</p>
        <div class="kpi__figure"><span class="kpi__number tabular" data-count-to="${clientes24h}">0</span></div>
        <div class="kpi__foot">${trendChip(clientes24h, clientes24hPrev)}<span>vs. ayer (${clientes24hPrev})</span></div>
      </article>
      <article class="kpi">
        <p class="kpi__label">Resueltas sin humano · 7 d</p>
        <div class="kpi__figure">
          <span class="kpi__number tabular"${pctResueltoSinHumano === null ? "" : ` data-count-to="${pctResueltoSinHumano}" data-suffix="%"`}>${pctResueltoSinHumano === null ? "—" : "0%"}</span>
          ${arcHtml}
        </div>
        <div class="kpi__foot">${pctResueltoSinHumano === null ? "Sin conversaciones cerradas en 7 días" : `Meta Fase 0: <b class="tabular" style="color:var(--ink)">${FASE0_META_RESUELTO_SIN_HUMANO}%</b>`}</div>
      </article>
    </section>

    <section class="block" aria-label="Actividad de mensajes">
      <div class="blockhead"><h2>Actividad — últimos 7 días</h2><span class="hint">mensajes / día</span></div>
      <div class="panel chartpanel">
        <div class="chart-wrap" id="chartWrap"></div>
        <script type="application/json" id="actividad-data">${JSON.stringify(dias)}</script>
      </div>
    </section>

    <section class="block" aria-label="Conversaciones recientes">
      <div class="blockhead"><h2>Conversaciones recientes</h2><span class="hint">últimas ${recientes.length}</span></div>
      <div class="panel">
        <ul class="convlist">${conversacionesHtml || '<li class="empty">Sin conversaciones todavía.</li>'}</ul>
      </div>
    </section>
  `;

  return layout("Resumen", tenant, body, "resumen");
}

type ConversacionesEstado = "todas" | "abiertas" | "escaladas" | "cerradas";

const CONVERSACIONES_TABS: { key: ConversacionesEstado; label: string }[] = [
  { key: "todas", label: "Todas" },
  { key: "abiertas", label: "Abiertas" },
  { key: "escaladas", label: "Escaladas" },
  { key: "cerradas", label: "Cerradas" },
];

// Cada filtro es una condición SQL independiente sobre columnas fijas
// (nunca interpola el `estado` de la URL) — ver conversaciones-leads-tickets.md,
// "Filtros por tab": Abiertas y Escaladas no son mutuamente excluyentes
// (escalar no cierra la conversación), a propósito.
const CONVERSACIONES_FILTRO_SQL: Record<ConversacionesEstado, string> = {
  todas: "",
  abiertas: "AND conv.status = 'open'",
  escaladas:
    "AND exists(select 1 from handoff_queue h2 where h2.conversation_id = conv.id and h2.status <> 'resuelto')",
  cerradas: "AND conv.status = 'closed'",
};

interface ConversacionListRow {
  id: string;
  status: string;
  customer_name: string | null;
  phone_number: string;
  ultimo_mensaje: string;
  ultimo_at: string;
  escalada: boolean;
}

interface ConversacionDetalleRow {
  id: string;
  status: string;
  started_at: string;
  closed_at: string | null;
  customer_name: string | null;
  phone_number: string;
}

/**
 * Inbox de conversaciones (Fase 11.2, ver docs/fase-11-panel-admin-dashboard/
 * conversaciones-leads-tickets.md): dos paneles servidos en una sola
 * respuesta HTML (sin htmx — mismo criterio ya usado en Fase 11.1 de no
 * sumar una dependencia de cliente nueva). La conversación seleccionada
 * viaja en `?c=<id>` (mismo patrón que usa el panel de referencia
 * externo) y el filtro de tab en `?estado=`.
 */
export async function renderConversacionesPage(
  tenantId: string,
  estadoParam: string | undefined,
  selectedId: string | undefined,
): Promise<string | null> {
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    return null;
  }
  const estado: ConversacionesEstado = CONVERSACIONES_TABS.some((t) => t.key === estadoParam)
    ? (estadoParam as ConversacionesEstado)
    : "todas";

  const { lista, detalle, mensajes } = await withTenant(tenantId, async (client) => {
    const listaResult = await client.query<ConversacionListRow>(
      `SELECT conv.id, conv.status, c.name AS customer_name, c.phone_number,
              m.content AS ultimo_mensaje, m.created_at AS ultimo_at,
              exists(select 1 from handoff_queue h where h.conversation_id = conv.id and h.status <> 'resuelto') AS escalada
       FROM conversations conv
       JOIN customers c ON c.id = conv.customer_id
       JOIN LATERAL (
         SELECT content, created_at FROM messages
         WHERE conversation_id = conv.id
         ORDER BY created_at DESC LIMIT 1
       ) m ON true
       WHERE true ${CONVERSACIONES_FILTRO_SQL[estado]}
       ORDER BY m.created_at DESC
       LIMIT 100`,
    );

    if (!selectedId) {
      return { lista: listaResult.rows, detalle: null, mensajes: [] as MessageRow[] };
    }

    const detalleResult = await client.query<ConversacionDetalleRow>(
      `SELECT conv.id, conv.status, conv.started_at, conv.closed_at,
              c.name AS customer_name, c.phone_number
       FROM conversations conv
       JOIN customers c ON c.id = conv.customer_id
       WHERE conv.id = $1`,
      [selectedId],
    );
    const detalle = detalleResult.rows[0] ?? null;
    if (!detalle) {
      return { lista: listaResult.rows, detalle: null, mensajes: [] as MessageRow[] };
    }

    const mensajesResult = await client.query<MessageRow>(
      `SELECT direction, sender_type, content, tool_calls, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [selectedId],
    );

    return { lista: listaResult.rows, detalle, mensajes: mensajesResult.rows };
  });

  const tabsHtml = CONVERSACIONES_TABS.map(
    (tab) =>
      `<a class="tab${tab.key === estado ? " tab--active" : ""}" href="/admin/${tenant.id}/conversaciones?estado=${tab.key}">${escapeHtml(tab.label)}</a>`,
  ).join("\n");

  const listaHtml = lista
    .map((row) => {
      const who = row.customer_name ?? row.phone_number;
      const chips = [
        row.escalada ? '<span class="chip chip--redline">Escalada</span>' : "",
        row.status === "closed" ? '<span class="chip">Cerrada</span>' : "",
      ]
        .filter(Boolean)
        .join("");
      return `<li>
        <a class="convitem${row.id === selectedId ? " convitem--active" : ""}" href="/admin/${tenant.id}/conversaciones?estado=${estado}&c=${row.id}">
          <div class="convitem__row">
            <span class="convitem__who">${escapeHtml(who)}</span>
            <span class="convitem__time">${formatRelativo(row.ultimo_at)}</span>
          </div>
          <span class="convitem__msg">${escapeHtml(truncate(row.ultimo_mensaje, 64))}</span>
          ${chips ? `<div class="convitem__chips">${chips}</div>` : ""}
        </a>
      </li>`;
    })
    .join("\n");

  let detalleHtml = `<div class="thread__empty">Selecciona una conversación de la lista.</div>`;
  if (detalle) {
    const who = detalle.customer_name ?? detalle.phone_number;
    const bubbles = mensajes
      .map(
        (row) =>
          `<div class="bubble ${row.direction}"><div>${renderMessageBody(row)}</div><span class="meta">${escapeHtml(row.sender_type)} · ${formatFecha(row.created_at)}</span></div>`,
      )
      .join("\n");
    detalleHtml = `
      <div class="thread__head">
        <h2>${escapeHtml(who)}</h2>
        <span class="thread__meta">${escapeHtml(detalle.phone_number)} · ${detalle.status === "closed" ? "cerrada" : "abierta"}</span>
      </div>
      <div class="thread__body">${bubbles || '<div class="thread__empty">Sin mensajes todavía.</div>'}</div>
    `;
  }

  const body = `
    <div class="pagehead">
      <p class="eyebrow">Panel</p>
      <h1>Conversaciones</h1>
      <p>Historial completo por cliente, con las tools que ejecutó el agente en cada turno.</p>
    </div>
    <div class="convtabs">${tabsHtml}</div>
    <div class="inbox">
      <aside class="panel inbox__list">
        <ul class="convitems">${listaHtml || '<li class="empty">Sin conversaciones en este filtro.</li>'}</ul>
      </aside>
      <section class="panel inbox__detail">${detalleHtml}</section>
    </div>
  `;

  return layout("Conversaciones", tenant, body, "conversaciones");
}

type LeadEstado = "con_pedido" | "escalada" | "con_cotizacion" | "sin_actividad_comercial";

// Mismas 4 categorías del funnel de docs/fase-8-observabilidad-seguridad/
// metricas-cierre-ventas.md, aplicadas por cliente en vez de por
// conversación — evita un segundo concepto de "estado de lead" paralelo
// (ver conversaciones-leads-tickets.md, "Leads").
const LEAD_ESTADO_LABEL: Record<LeadEstado, string> = {
  con_pedido: "Con pedido",
  escalada: "Escalada",
  con_cotizacion: "Con cotización",
  sin_actividad_comercial: "Sin actividad",
};
const LEAD_ESTADO_CHIP: Record<LeadEstado, string> = {
  con_pedido: "chip--go",
  escalada: "chip--redline",
  con_cotizacion: "chip--amber",
  sin_actividad_comercial: "chip--muted",
};

const LEADS_QUERY = `
  SELECT
    c.id, c.name, c.phone_number, c.created_at,
    m.content AS ultimo_mensaje,
    CASE
      WHEN o.customer_id IS NOT NULL THEN 'con_pedido'
      WHEN h.customer_id IS NOT NULL THEN 'escalada'
      WHEN q.customer_id IS NOT NULL THEN 'con_cotizacion'
      ELSE 'sin_actividad_comercial'
    END AS estado
  FROM customers c
  LEFT JOIN LATERAL (
    SELECT content FROM messages msg
    JOIN conversations conv ON conv.id = msg.conversation_id
    -- direction = 'inbound' no basta: el orquestador también guarda los
    -- tool_results y reintentos del guardrail como inbound/agent con
    -- content vacío (ver loop.ts) — sender_type = 'customer' filtra eso
    -- y deja el último mensaje real que escribió el cliente.
    WHERE conv.customer_id = c.id AND msg.direction = 'inbound' AND msg.sender_type = 'customer'
    ORDER BY msg.created_at DESC LIMIT 1
  ) m ON true
  LEFT JOIN (SELECT DISTINCT customer_id FROM orders) o ON o.customer_id = c.id
  LEFT JOIN (
    SELECT DISTINCT conv.customer_id FROM handoff_queue h
    JOIN conversations conv ON conv.id = h.conversation_id
  ) h ON h.customer_id = c.id
  LEFT JOIN (SELECT DISTINCT customer_id FROM quotes) q ON q.customer_id = c.id
  ORDER BY c.created_at DESC
`;

interface LeadRow {
  id: string;
  name: string | null;
  phone_number: string;
  created_at: string;
  ultimo_mensaje: string | null;
  estado: LeadEstado;
}

async function fetchLeads(tenantId: string): Promise<LeadRow[]> {
  return withTenant(tenantId, async (client) => {
    const result = await client.query<LeadRow>(LEADS_QUERY);
    return result.rows;
  });
}

/**
 * Leads (Fase 11.2, ver docs/fase-11-panel-admin-dashboard/
 * conversaciones-leads-tickets.md): "resumen" y "estado" se derivan de
 * datos ya existentes, no de un resumen generado por LLM — evita el costo
 * recurrente que mapeo-funcionalidades.md marca fuera de alcance.
 */
export async function renderLeadsPage(tenantId: string): Promise<string | null> {
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    return null;
  }
  const rows = await fetchLeads(tenantId);

  const tableRows = rows
    .map((row) => {
      const who = row.name ?? row.phone_number;
      const search = [row.name, row.phone_number, row.ultimo_mensaje, LEAD_ESTADO_LABEL[row.estado]]
        .filter((v): v is string => Boolean(v))
        .join(" ")
        .toLowerCase();
      return `<tr data-search="${escapeHtml(search)}">
        <td>${escapeHtml(who)}</td>
        <td>${escapeHtml(row.ultimo_mensaje ?? "")}</td>
        <td><span class="chip ${LEAD_ESTADO_CHIP[row.estado]}">${escapeHtml(LEAD_ESTADO_LABEL[row.estado])}</span></td>
        <td class="mono">${formatFecha(row.created_at)}</td>
      </tr>`;
    })
    .join("\n");

  const body = `
    <div class="pagehead">
      <p class="eyebrow">Panel</p>
      <div class="pagehead__row">
        <div>
          <h1>Leads</h1>
          <p>${rows.length} clientes, clasificados por su avance en el funnel comercial.</p>
        </div>
        <a class="btn" href="/admin/${tenant.id}/leads.csv">Exportar CSV</a>
      </div>
    </div>
    <div class="panel tablewrap" data-table data-page-size="20">
      <div class="tabletools">
        <input type="search" class="searchbox" data-table-search placeholder="Buscar por cliente, mensaje o estado…" aria-label="Buscar leads">
        <span class="hint tabular"><span data-table-count>${rows.length}</span> de ${rows.length}</span>
      </div>
      <table data-resizable-table="leads">
        <colgroup>
          <col style="width:20%"><col style="width:44%"><col style="width:18%"><col style="width:18%">
        </colgroup>
        <thead><tr><th>Cliente</th><th>Último mensaje</th><th>Estado</th><th>Cliente desde</th></tr></thead>
        <tbody>${tableRows || '<tr><td colspan="4" class="empty">Sin leads todavía.</td></tr>'}</tbody>
      </table>
      <div class="pager" data-table-pager>
        <button type="button" data-table-prev aria-label="Página anterior">‹</button>
        <span class="tabular" data-table-pagelabel>1 / 1</span>
        <button type="button" data-table-next aria-label="Página siguiente">›</button>
      </div>
    </div>
  `;

  return layout(`Leads (${rows.length})`, tenant, body, "leads");
}

/** Mismo dato que renderLeadsPage, serializado a mano igual que el resto del panel arma HTML a mano (sin dependencia nueva). */
export async function exportLeadsCsv(tenantId: string): Promise<string | null> {
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    return null;
  }
  const rows = await fetchLeads(tenantId);
  return toCsv(
    ["nombre", "telefono", "ultimo_mensaje", "estado", "cliente_desde"],
    rows.map((row) => [
      row.name ?? "",
      row.phone_number,
      row.ultimo_mensaje ?? "",
      LEAD_ESTADO_LABEL[row.estado],
      // pg parsea timestamptz como objeto Date, no string, pese al tipo
      // declarado en LeadRow — a diferencia de formatFecha() (que ya
      // tolera Date u string vía `new Date(value)`), acá se serializa a
      // mano, así que hay que normalizar explícito antes de armar el CSV.
      new Date(row.created_at).toISOString(),
    ]),
  );
}

const HANDOFF_REASON_LABEL: Record<string, string> = {
  compatibilidad_tecnica: "Compatibilidad técnica",
  monto_alto: "Monto alto",
  solicitud_cliente: "Solicitud del cliente",
  intentos_fallidos: "Intentos fallidos",
  queja: "Queja",
  guardrail_precio: "Guardrail de precio",
  fuera_de_alcance: "Fuera de alcance",
};

// "Vigilante" (Fase 12.1, ver docs/fase-12-capacidades-proactivas-agente/
// analisis-superpoderes.md, superpoder #2): el aviso por WhatsApp ante
// estos motivos ya existe desde la Fase 7 (escalarHumano.ts) — lo que
// faltaba era poder distinguirlos a simple vista en el listado de
// Tickets. "queja" = cliente se enoja; "monto_alto" = venta en riesgo.
const RISKY_REASONS = new Set(["queja", "monto_alto"]);

const HANDOFF_STATUS_LABEL: Record<string, string> = {
  queued: "En cola",
  en_atencion: "En atención",
  resuelto: "Resuelto",
};
const HANDOFF_STATUS_CHIP: Record<string, string> = {
  queued: "chip--redline",
  en_atencion: "chip--amber",
  resuelto: "chip--go",
};

interface TicketRow {
  id: string;
  conversation_id: string;
  reason: string;
  status: string;
  assigned_to_name: string | null;
  created_at: string;
  resolved_at: string | null;
  summary: string | null;
  customer_name: string | null;
  phone_number: string;
}

/**
 * Tickets (Fase 11.2): agrega la vista faltante de "todos los casos
 * escalados de un tenant a la vez" sobre handoff_queue — hoy solo es
 * accesible por token individual (GET /asesor/:token, src/advisor/
 * handoffView.ts). No reemplaza ese flujo, es solo de supervisión.
 */
export async function renderTicketsPage(tenantId: string): Promise<string | null> {
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    return null;
  }

  const rows = await withTenant(tenantId, async (client) => {
    const result = await client.query<TicketRow>(
      `SELECT h.id, h.conversation_id, h.reason, h.status, h.created_at, h.resolved_at, h.summary,
              ha.name AS assigned_to_name, c.name AS customer_name, c.phone_number
       FROM handoff_queue h
       JOIN conversations conv ON conv.id = h.conversation_id
       JOIN customers c ON c.id = conv.customer_id
       LEFT JOIN human_agents ha ON ha.id = h.assigned_to
       ORDER BY h.created_at DESC`,
    );
    return result.rows;
  });

  const tableRows = rows
    .map((row) => {
      const who = row.customer_name ?? row.phone_number;
      const reasonLabel = HANDOFF_REASON_LABEL[row.reason] ?? row.reason;
      const isRisky = RISKY_REASONS.has(row.reason);
      const statusLabel = HANDOFF_STATUS_LABEL[row.status] ?? row.status;
      const statusChip = HANDOFF_STATUS_CHIP[row.status] ?? "chip--muted";
      const search = [who, reasonLabel, statusLabel, row.assigned_to_name, row.summary, isRisky ? "riesgo" : ""]
        .filter((v): v is string => Boolean(v))
        .join(" ")
        .toLowerCase();
      const reasonCell = isRisky
        ? `<span class="chip chip--redline" title="Vigilante: cliente en riesgo">⚠ ${escapeHtml(reasonLabel)}</span>`
        : escapeHtml(reasonLabel);
      return `<tr data-search="${escapeHtml(search)}">
        <td>${escapeHtml(who)}</td>
        <td>${reasonCell}</td>
        <td><span class="chip ${statusChip}">${escapeHtml(statusLabel)}</span></td>
        <td>${escapeHtml(row.assigned_to_name ?? "Sin asignar")}</td>
        <td class="mono">${formatFecha(row.created_at)}</td>
        <td>${escapeHtml(row.summary ?? "")}</td>
        <td><a class="linklike" href="/admin/${tenant.id}/conversaciones?estado=escaladas&c=${row.conversation_id}">Ver conversación →</a></td>
      </tr>`;
    })
    .join("\n");

  const body = `
    <div class="pagehead">
      <p class="eyebrow">Panel</p>
      <h1>Tickets</h1>
      <p>${rows.length} casos escalados a un asesor humano, de todos los estados.</p>
    </div>
    <div class="panel tablewrap" data-table data-page-size="20">
      <div class="tabletools">
        <input type="search" class="searchbox" data-table-search placeholder="Buscar por cliente, motivo, estado o asesor…" aria-label="Buscar tickets">
        <span class="hint tabular"><span data-table-count>${rows.length}</span> de ${rows.length}</span>
      </div>
      <table data-resizable-table="tickets">
        <colgroup>
          <col style="width:15%"><col style="width:14%"><col style="width:10%">
          <col style="width:13%"><col style="width:11%"><col style="width:25%"><col style="width:12%">
        </colgroup>
        <thead><tr><th>Cliente</th><th>Motivo</th><th>Estado</th><th>Asignado a</th><th>Creado</th><th>Resumen</th><th></th></tr></thead>
        <tbody>${tableRows || '<tr><td colspan="7" class="empty">Sin tickets todavía.</td></tr>'}</tbody>
      </table>
      <div class="pager" data-table-pager>
        <button type="button" data-table-prev aria-label="Página anterior">‹</button>
        <span class="tabular" data-table-pagelabel>1 / 1</span>
        <button type="button" data-table-next aria-label="Página siguiente">›</button>
      </div>
    </div>
  `;

  return layout(`Tickets (${rows.length})`, tenant, body, "tickets");
}

// Nombres reales de src/orchestrator/toolDefinitions.ts — no los nodos
// genéricos del panel de referencia externo (ver flujo-conexiones.md).
const AGENT_TOOLS: { name: string; label: string }[] = [
  { name: "consultar_inventario", label: "Consultar inventario" },
  { name: "generar_cotizacion", label: "Generar cotización" },
  { name: "aplicar_promocion", label: "Aplicar promoción" },
  { name: "crear_pedido", label: "Crear pedido" },
  { name: "recomendar_producto", label: "Recomendar producto" },
  { name: "escalar_a_humano", label: "Escalar a humano" },
];

interface ToolCountRow {
  tool: string;
  llamadas_30d: string;
}

/**
 * Flujo del agente (Fase 11.3, ver docs/fase-11-panel-admin-dashboard/
 * flujo-conexiones.md): diagrama estático con los nodos reales del
 * orquestador — no editable, mismo criterio que el panel de referencia
 * ("radiografía honesta, no un editor"). Los contadores por tool se
 * derivan de messages.tool_calls, sin tabla nueva.
 */
export async function renderFlujoPage(tenantId: string): Promise<string | null> {
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    return null;
  }

  const counts = await withTenant(tenantId, async (client) => {
    const result = await client.query<ToolCountRow>(
      `SELECT block ->> 'name' AS tool, count(*) AS llamadas_30d
       FROM messages m, jsonb_array_elements(m.tool_calls) AS block
       WHERE m.tool_calls IS NOT NULL
         AND block ->> 'type' = 'tool_use'
         AND m.created_at >= now() - interval '30 days'
       GROUP BY 1`,
    );
    return new Map(result.rows.map((row) => [row.tool, Number(row.llamadas_30d)]));
  });

  const toolPills = AGENT_TOOLS.map(
    (tool) =>
      `<div class="toolpill"><span>${escapeHtml(tool.label)}</span><span class="toolpill__count tabular">${counts.get(tool.name) ?? 0}</span></div>`,
  ).join("\n");

  const modelo = `${env.llmProvider === "anthropic" ? "Anthropic" : "OpenAI-compatible"} · ${escapeHtml(env.llmModel)}`;

  const body = `
    <div class="pagehead">
      <p class="eyebrow">Agente</p>
      <h1>Flujo</h1>
      <p>Cómo procesa el agente un mensaje de ${escapeHtml(brandName(tenant))}, con los nodos reales del orquestador.</p>
    </div>
    <div class="flow">
      <div class="flownode">
        <span class="flownode__eyebrow">Canal</span>
        <span class="flownode__title">WhatsApp · Twilio</span>
      </div>
      <div class="flowline"></div>
      <div class="flownode flownode--core">
        <span class="flownode__eyebrow">Orquestador</span>
        <span class="flownode__title mono">src/orchestrator/loop.ts</span>
        <div class="flowsub">
          <div class="flowsub__row"><span class="flowsub__label">Modelo</span><span class="mono">${modelo}</span></div>
          <div class="flowsub__row"><span class="flowsub__label">Memoria</span><span>Estado de la conversación + historial completo de mensajes</span></div>
          <div class="flowsub__row flowsub__row--tools"><span class="flowsub__label">Tools</span><div class="toolgrid">${toolPills}</div></div>
        </div>
      </div>
      <div class="flowline"></div>
      <div class="flownode">
        <span class="flownode__eyebrow">Respuesta</span>
        <span class="flownode__title">Outbound vía Twilio</span>
      </div>
    </div>
    <p class="flowfoot">Llamadas por tool en los últimos 30 días.</p>
  `;

  return layout("Flujo del agente", tenant, body, "flujo");
}

/**
 * Conexiones (Fase 11.3): una sola tarjeta real (WhatsApp/Twilio) — no
 * se construyen tarjetas para canales sin integración real detrás
 * (Telegram, Instagram, etc. no tienen variables de entorno en el
 * proyecto). El estado lee las mismas env vars que ya exige env.ts al
 * arrancar; si el proceso está corriendo, ya están presentes por
 * definición — el chequeo se deja explícito igual, para que agregar un
 * canal con credenciales realmente opcionales en el futuro sea agregar
 * una entrada a esta lista, no rediseñar la página.
 */
export async function renderConexionesPage(tenantId: string): Promise<string | null> {
  const tenant = await getTenant(tenantId);
  if (!tenant) {
    return null;
  }

  const missing = [
    !env.twilioAccountSid && "TWILIO_ACCOUNT_SID",
    !env.twilioAuthToken && "TWILIO_AUTH_TOKEN",
    !env.twilioWhatsappNumber && "TWILIO_WHATSAPP_NUMBER",
  ].filter((v): v is string => Boolean(v));
  const conectado = missing.length === 0;
  // env.publicWebhookUrl ya es la URL completa del webhook (así la exige
  // twilioSignature.ts para validar la firma) — no hay que concatenarle
  // el path de nuevo.
  const webhookUrl = env.publicWebhookUrl;
  const sidMasked = conectado ? `••••${env.twilioAccountSid.slice(-4)}` : "—";

  const body = `
    <div class="pagehead">
      <p class="eyebrow">Agente</p>
      <h1>Conexiones</h1>
      <p>Canales conectados al agente de ${escapeHtml(brandName(tenant))}.</p>
    </div>
    <div class="panel connection">
      <div class="connection__head">
        <h2>WhatsApp · Twilio</h2>
        <span class="connection__badge ${conectado ? "connection__badge--on" : "connection__badge--off"}">${conectado ? '<span class="pulse"></span>Conectado' : "Sin conectar"}</span>
      </div>
      <dl class="connection__meta">
        <div><dt>Número del tenant</dt><dd class="mono">${escapeHtml(tenant.whatsapp_number ?? "Sin asignar")}</dd></div>
        <div><dt>Cuenta Twilio</dt><dd class="mono">${escapeHtml(sidMasked)}</dd></div>
      </dl>
      <div class="connection__webhook">
        <label for="webhook-url">URL de webhook (configúrala en la consola de Twilio)</label>
        <div class="copyrow">
          <code id="webhook-url" class="mono">${escapeHtml(webhookUrl)}</code>
          <button type="button" class="btn" data-copy="${escapeHtml(webhookUrl)}">Copiar</button>
        </div>
      </div>
      ${!conectado ? `<p class="connection__missing">Falta configurar: ${escapeHtml(missing.join(", "))}</p>` : ""}
    </div>
  `;

  return layout("Conexiones", tenant, body, "conexiones");
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
      const search = [row.sku, row.name, row.category, row.description]
        .filter((v): v is string => Boolean(v))
        .join(" ")
        .toLowerCase();
      return `<tr data-search="${escapeHtml(search)}">
        <td>${img}</td>
        <td class="mono">${escapeHtml(row.sku)}</td>
        <td>${escapeHtml(row.name)}</td>
        <td>${escapeHtml(row.category ?? "")}</td>
        <td class="mono">${formatCOP(row.price)}</td>
        <td class="mono ${stock === 0 ? "stock-cero" : ""}">${stock}</td>
        <td>${escapeHtml(row.description ?? "")}</td>
      </tr>`;
    })
    .join("\n");

  const body = `
    <div class="pagehead">
      <p class="eyebrow">Catálogo</p>
      <h1>Productos</h1>
      <p>${rows.length} productos en el catálogo de ${escapeHtml(brandName(tenant))}.</p>
    </div>
    <div class="panel tablewrap" data-table data-page-size="20">
      <div class="tabletools">
        <input type="search" class="searchbox" data-table-search placeholder="Buscar por SKU, nombre, categoría o descripción…" aria-label="Buscar productos">
        <span class="hint tabular"><span data-table-count>${rows.length}</span> de ${rows.length}</span>
      </div>
      <table data-resizable-table="productos">
        <colgroup>
          <col style="width:7%"><col style="width:9%"><col style="width:19%">
          <col style="width:11%"><col style="width:9%"><col style="width:7%"><col style="width:38%">
        </colgroup>
        <thead><tr><th>Foto</th><th>SKU</th><th>Nombre</th><th>Categoría</th><th>Precio</th><th>Stock</th><th>Descripción</th></tr></thead>
        <tbody>${tableRows || '<tr><td colspan="7" class="empty">Sin productos todavía.</td></tr>'}</tbody>
      </table>
      <div class="pager" data-table-pager>
        <button type="button" data-table-prev aria-label="Página anterior">‹</button>
        <span class="tabular" data-table-pagelabel>1 / 1</span>
        <button type="button" data-table-next aria-label="Página siguiente">›</button>
      </div>
    </div>
  `;

  return layout(`Catálogo (${rows.length} productos)`, tenant, body, "productos");
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
        .map((item) => `<li>${item.quantity}× ${escapeHtml(item.name)} (${formatCOP(item.unit_price)})</li>`)
        .join("");
      const search = [
        row.customer_name,
        row.phone_number,
        row.status,
        row.payment_method,
        row.delivery_method,
        ...row.items.map((item) => item.name),
      ]
        .filter((v): v is string => Boolean(v))
        .join(" ")
        .toLowerCase();
      return `<tr data-search="${escapeHtml(search)}">
        <td>${escapeHtml(row.customer_name ?? row.phone_number)}</td>
        <td><ul class="items">${items}</ul></td>
        <td>${escapeHtml(row.status)}</td>
        <td>${escapeHtml(row.payment_method)}</td>
        <td>${escapeHtml(row.delivery_method)}</td>
        <td class="mono">${formatCOP(row.total)}</td>
        <td class="mono">${formatFecha(row.created_at)}</td>
      </tr>`;
    })
    .join("\n");

  const body = `
    <div class="pagehead">
      <p class="eyebrow">Catálogo</p>
      <h1>Pedidos</h1>
      <p>${rows.length} pedidos confirmados de ${escapeHtml(brandName(tenant))}.</p>
    </div>
    <div class="panel tablewrap" data-table data-page-size="20">
      <div class="tabletools">
        <input type="search" class="searchbox" data-table-search placeholder="Buscar por cliente, producto, estado…" aria-label="Buscar pedidos">
        <span class="hint tabular"><span data-table-count>${rows.length}</span> de ${rows.length}</span>
      </div>
      <table data-resizable-table="pedidos">
        <colgroup>
          <col style="width:15%"><col style="width:28%"><col style="width:11%">
          <col style="width:14%"><col style="width:14%"><col style="width:9%"><col style="width:9%">
        </colgroup>
        <thead><tr><th>Cliente</th><th>Items</th><th>Estado</th><th>Pago</th><th>Entrega</th><th>Total</th><th>Fecha</th></tr></thead>
        <tbody>${tableRows || '<tr><td colspan="7" class="empty">Sin pedidos todavía.</td></tr>'}</tbody>
      </table>
      <div class="pager" data-table-pager>
        <button type="button" data-table-prev aria-label="Página anterior">‹</button>
        <span class="tabular" data-table-pagelabel>1 / 1</span>
        <button type="button" data-table-next aria-label="Página siguiente">›</button>
      </div>
    </div>
  `;

  return layout(`Pedidos (${rows.length})`, tenant, body, "pedidos");
}
