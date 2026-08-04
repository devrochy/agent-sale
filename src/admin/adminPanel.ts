import { escapeHtml, renderMessageBody, type MessageRow } from "../advisor/handoffView.js";
import {
  createAdmin,
  isAdminRole,
  listAdmins,
  setAdminActive,
  updateAdminPermissions,
  updateAdminProfile,
  type AdminPermissions,
  type AdminRecord,
} from "./auth/adminsDirectory.js";
import { hashPassword } from "./auth/passwordHash.js";
import { env } from "../config/env.js";
import {
  createAlly,
  listAllies,
  setAllyActive,
  updateAlly,
  type AllyRecord,
} from "../shared/db/alliesDirectory.js";
import {
  createCategory,
  listAllComplementPairs,
  listCategories,
  setCategoryActive,
  setComplements,
  updateCategory,
  type CategoryRecord,
} from "../shared/db/productCategoriesDirectory.js";
import {
  classifySkus,
  countProductsPerAlly,
  countProductsPerCategory,
  createProduct,
  findVariantBySku,
  getProductDetail,
  listProductsSummary,
  updateProduct,
  updateVariantStockAndPrice,
  type ProductDetail,
  type VariantInput,
  type VariantUpdateInput,
} from "../shared/db/productsDirectory.js";
import { parseCsv } from "../shared/csv/parseCsv.js";
import { isEstiloMensajes, isVelocidadRespuesta, resolveBehaviorConfig } from "../orchestrator/behaviorConfig.js";
import {
  isLlmRoutingMode,
  isProviderKey,
  PROVIDER_CATALOG,
  testLlmConfig,
  type ProviderKey,
} from "../orchestrator/llm/index.js";
import { isTono } from "../orchestrator/toneBlocks.js";
import { createPaymentLink, MIN_AMOUNT_COP } from "../payments/wompiClient.js";
import {
  clearLlmConfig,
  getBehaviorConfig,
  getLlmConfig,
  getReportFrequencyDays,
  getReportRecipient,
  getReviewLink,
  getSettings,
  getWompiConfig,
  saveBehaviorConfig,
  saveLlmConfig,
  saveReportFrequencyDays,
  saveReportRecipient,
  saveReviewLink,
  saveWompiConfig,
  setBotPaused,
  type SettingsSummary,
} from "../shared/db/settingsDirectory.js";
import { withTransaction } from "../shared/db/withTransaction.js";
import {
  convertFromUsd,
  CURRENCY_META,
  formatMoney,
  getUsdExchangeRates,
  isCurrency,
  SUPPORTED_CURRENCIES,
  type Currency,
} from "../shared/exchangeRates.js";

/**
 * Panel interno (ver docs de Fase 8/9/11/13): protegido por login real
 * por tenant (Fase 13, ver src/admin/auth/ y ADR-025) — Basic Auth global
 * quedó retirado. Sirve para operar/depurar el piloto — no es un
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

/** Orden de un árbol de categorías por profundidad (DFS, hijos por sort_order) — para <select> indentado y para la tabla de /admin/categorias. */
function categoryTreeOrder(categories: CategoryRecord[]): { id: string; name: string; depth: number }[] {
  const byParent = new Map<string | null, CategoryRecord[]>();
  for (const category of categories) {
    const siblings = byParent.get(category.parentId) ?? [];
    siblings.push(category);
    byParent.set(category.parentId, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  const ordered: { id: string; name: string; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const category of byParent.get(parentId) ?? []) {
      ordered.push({ id: category.id, name: category.name, depth });
      walk(category.id, depth + 1);
    }
  };
  walk(null, 0);
  return ordered;
}

function categoryOptionsHtml(categories: CategoryRecord[], selectedId: string | null): string {
  const blank = `<option value=""${selectedId === null ? " selected" : ""}>Sin categoría</option>`;
  const options = categoryTreeOrder(categories)
    .map(
      (c) =>
        `<option value="${c.id}"${c.id === selectedId ? " selected" : ""}>${"— ".repeat(c.depth)}${escapeHtml(c.name)}</option>`,
    )
    .join("");
  return blank + options;
}

function allyOptionsHtml(allies: AllyRecord[], selectedId: string): string {
  return allies
    .map((a) => `<option value="${a.id}"${a.id === selectedId ? " selected" : ""}>${escapeHtml(a.name)}</option>`)
    .join("");
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
  delivery_address: string | null;
  delivery_id_document: string | null;
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

function brandName(settings: SettingsSummary): string {
  return settings.display_name ?? settings.name;
}

/** Icono + título + explicación en voz del panel, no una frase gris suelta — ver Fase 11 (mejora informada por el panel de referencia externo). */
function emptyState(icon: string, title: string, desc: string): string {
  return `<div class="emptystate"><span class="emptystate__icon">${icon}</span><p class="emptystate__title">${escapeHtml(title)}</p><p class="emptystate__desc">${escapeHtml(desc)}</p></div>`;
}

/** Tarjeta seleccionable (radio + label, sin JS) para Configuración → Voz y estilo — reemplaza los <select> por el patrón táctil del panel de referencia externo, adaptado a los iconos y color de acento propios de este panel. */
function choiceCard(name: string, value: string, current: string, icon: string, title: string, desc: string): string {
  const checked = value === current;
  return `<label class="choice">
    <input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${checked ? " checked" : ""}>
    <span class="choice__card">
      <span class="choice__icon">${icon}</span>
      <span class="choice__title">${escapeHtml(title)}</span>
      <span class="choice__desc">${escapeHtml(desc)}</span>
    </span>
  </label>`;
}

const ICON_PRODUCTOS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5.2 8 2l6 3.2v5.6L8 14 2 10.8V5.2Z"/><path d="M2 5.2 8 8l6-2.8"/><path d="M8 8v6"/></svg>';

const ICON_PEDIDOS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2h8v11.5l-1.5-1-1.5 1-1.5-1-1.5 1-1.5-1-1.5 1V2Z"/><path d="M6 5.5h4M6 8h4M6 10.5h2.5"/></svg>';

const ICON_ALIADOS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/><path d="M10.5 13a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/><path d="M7.6 6.9 8.9 8.5"/></svg>';

const ICON_CATEGORIAS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.6h3.4v3.4H2.5V3.6Z"/><path d="M10.1 3.6h3.4v3.4h-3.4V3.6Z"/><path d="M2.5 9h3.4v3.4H2.5V9Z"/><path d="M10.1 9h3.4v3.4h-3.4V9Z"/></svg>';

const ICON_RESUMEN =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.3 11.5a5.7 5.7 0 1 1 11.4 0"/><path d="M8 11.5 10.4 6.8"/><circle cx="8" cy="11.5" r="0.9" fill="currentColor" stroke="none"/></svg>';

const ICON_CONVERSACIONES =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.6h12v7.3H6.6L3.6 13.4v-2.5H2V3.6Z"/><path d="M5 6.6h6M5 8.6h3.5"/></svg>';

const ICON_LEADS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="5.1" r="2.5"/><path d="M2.6 13.4c.8-2.9 2.7-4.3 5.4-4.3s4.6 1.4 5.4 4.3"/></svg>';

const ICON_TICKETS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6.4V4.7c0-.4.3-.7.7-.7h10.6c.4 0 .7.3.7.7v1.7a1.2 1.2 0 0 0 0 2.4v1.7c0 .4-.3.7-.7.7H2.7a.7.7 0 0 1-.7-.7V8.8a1.2 1.2 0 0 0 0-2.4Z"/><path d="M6.2 4v8" stroke-dasharray="1.3 1.3"/></svg>';

const ICON_ANALITICA =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 13.5h11"/><path d="M4.5 13.5V9"/><path d="M8 13.5V6"/><path d="M11.5 13.5V3"/></svg>';

const ICON_FLUJO =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="2.8" cy="2.8" r="1.5"/><circle cx="2.8" cy="13.2" r="1.5"/><circle cx="12.6" cy="8" r="1.7"/><path d="M4.2 3.5 11 7.2M4.2 12.5 11 8.8"/></svg>';

const ICON_CONEXIONES =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.3 2v3.2M10.7 2v3.2M3.8 5.2h8.4v2.7a4.2 4.2 0 0 1-8.4 0V5.2Z"/><path d="M8 12v2.4"/></svg>';

const ICON_CONFIGURACION =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.1"/><path d="M8 2.4v1.5M8 12.1v1.5M13.6 8h-1.5M3.9 8H2.4M11.9 4.1l-1.05 1.05M5.15 10.85 4.1 11.9M11.9 11.9l-1.05-1.05M5.15 5.15 4.1 4.1"/></svg>';
const ICON_COLABORADORES =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5.5" cy="5.5" r="2.3"/><path d="M1.6 13.4c.5-2.4 2-3.6 3.9-3.6s3.4 1.2 3.9 3.6"/><circle cx="11.2" cy="5.9" r="1.9"/><path d="M10 9.9c1.6.1 2.7 1.2 3.1 3.1"/></svg>';

const ICON_WHATSAPP =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2a5.6 5.6 0 0 0-4.8 8.5L2.4 13.6l3-.75A5.6 5.6 0 1 0 8 2.2Z"/><path d="M5.7 5.9c.15-.35.3-.35.45-.35h.3c.15 0 .3 0 .45.35.2.45.6 1.35.65 1.45.05.1.1.25 0 .4-.1.2-.15.3-.3.45-.15.2-.3.3-.15.55.5.9 1.1 1.5 2 2 .25.15.35.1.5-.05.15-.15.6-.7.75-.9.15-.2.3-.15.5-.1.2.1 1.3.6 1.5.7.2.1.35.15.4.25.05.15.05.7-.2 1.15-.25.45-1.15.85-1.55.85-.4 0-.85.05-2.7-1.1-1.65-1-2.6-2.5-2.75-2.75-.15-.25-1.05-1.55-1-2.6.05-1.05.6-1.5.8-1.7Z" fill="currentColor" stroke="none"/></svg>';

const ICON_ORQUESTADOR =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.8" y="4.8" width="6.4" height="6.4" rx="1"/><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4"/></svg>';

const ICON_RESPUESTA =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8h10.6M9 4.4 12.6 8 9 11.6"/></svg>';

const ICON_TOOL =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 2.6a3 3 0 0 0-3.9 3.7L2.6 10.4a1.4 1.4 0 0 0 2 2l4.1-4.1a3 3 0 0 0 3.7-3.9l-2 2-1.5-.5-.5-1.5 2.2-2.2Z"/></svg>';

const ICON_TONO_CALIDO =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M5.4 9.2c.5.9 1.4 1.4 2.6 1.4s2.1-.5 2.6-1.4"/><path d="M5.9 6.3h.01M10.1 6.3h.01"/></svg>';

const ICON_TONO_FORMAL =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.2 3.4h7.6l-1 2.6 1 2.6H4.2Z"/><path d="M4.2 3.4v9.2"/></svg>';

const ICON_TONO_DIVERTIDO =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8 9 5l3.2-1.4L10.6 6.6 14 8l-3.4 1.2L12 12.6 8.8 11l-.8 3.2-.8-3.2L4 12.6l1.4-3.4L2 8l3.4-1.4L4 3.6 7.2 5Z"/></svg>';

const ICON_VEL_INMEDIATO =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.6 1.6 3.4 9h3.4l-1 5.4 5.8-8.2H8.2l.4-4.6Z"/></svg>';

const ICON_VEL_RAPIDO =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.4v9.2M5.4 3.4 10 8l-4.6 4.6M9.4 3.4 14 8l-4.6 4.6"/></svg>';

const ICON_VEL_NORMAL =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.4 1.4"/></svg>';

const ICON_VEL_PAUSADO =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.6 3h6.8M4.6 13h6.8M5.2 3c0 2.4 1 3.3 2.8 4.3-1.8 1-2.8 1.9-2.8 4.3M10.8 3c0 2.4-1 3.3-2.8 4.3 1.8 1 2.8 1.9 2.8 4.3"/></svg>';

const ICON_ESTILO_UNO =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.4 3.6h11.2v6.4H7l-2.6 2.4v-2.4H2.4V3.6Z"/></svg>';

const ICON_ESTILO_POCOS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 2.6h8v4.2H5.6L3.4 8.6V6.8H2V2.6Z"/><path d="M6.4 9h7.6v4.2h-2.4v1.8L9.4 13.2H6.4V9Z"/></svg>';

const ICON_ESTILO_VARIOS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.8 2.4h6.4v3.2H4.6L2.8 7v-1.6H1.8V2.4Z"/><path d="M7.8 6.4h6.4v3.2h-1.4V11l-2-1.4H7.8V6.4Z"/><path d="M3.4 10.2h6.4v3.2H7.2l-1.8 1.6v-1.6H3.4v-3.2Z"/></svg>';

type ActiveSection =
  | "resumen"
  | "conversaciones"
  | "leads"
  | "tickets"
  | "analitica"
  | "flujo"
  | "conexiones"
  | "configuracion"
  | "productos"
  | "pedidos"
  | "aliados"
  | "categorias"
  | "colaboradores"
  | "perfil"
  | null;

const ICON_COLLAPSE =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3 6 8l4 5"/></svg>';

const ICON_IGNITION =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2v5"/><path d="M4.4 4.3a5 5 0 1 0 7.2 0"/></svg>';

const ICON_EDIT =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 2.6a1.6 1.6 0 0 1 2.3 2.3L5.8 12l-2.9.7.7-2.9 7-7Z"/></svg>';

/** Guardar (Productos/Aliados/Categorías, edición rápida por doble clic) — icon-only para no competir en ancho con Editar/el switch de estado en la columna de Acciones. */
const ICON_SAVE =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4"/></svg>';

const ICON_LOGOUT =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.2 2.6H3.4a1 1 0 0 0-1 1v8.8a1 1 0 0 0 1 1h2.8"/><path d="M10.4 5.2 13.6 8l-3.2 2.8"/><path d="M13.4 8H6"/></svg>';

const ICON_PLUS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';

/** Flecha hacia una bandeja — "subir archivo" (botón "Importar CSV" de Productos). */
const ICON_IMPORT =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 10.2V2.5"/><path d="M4.8 5.3 8 2.2l3.2 3.1"/><path d="M2.5 11v1.7a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11"/></svg>';

/** Flecha de expandir/colapsar (variantes de producto, ramas del árbol de categorías) — rota 90°/-90° por CSS según el estado, no son dos iconos distintos. */
const ICON_CHEVRON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

const ICON_CALENDARIO =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3.2" width="11" height="10.3" rx="1.2"/><path d="M2.5 6.2h11M5.3 2v2.4M10.7 2v2.4"/></svg>';

const ICON_PERSONALIZADO =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h10"/><circle cx="6" cy="4.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="11" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="7" cy="11.5" r="1.3" fill="currentColor" stroke="none"/></svg>';

function navRail(settings: SettingsSummary, active: ActiveSection, admin: AdminRecord): string {
  const isMaster = admin.role === "master";
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

  const canal = settings.whatsapp_number ? `WhatsApp configurado` : `Sin canal configurado`;

  const perfilActive = active === "perfil";
  const avatar = admin.avatarData
    ? `<img src="${escapeHtml(admin.avatarData)}" class="avatar" alt="">`
    : `<span class="avatar avatar--initial">${escapeHtml(admin.username.charAt(0).toUpperCase())}</span>`;
  // Botón (no link directo): abre el menú de cuenta de abajo — "Editar
  // perfil" navega a /admin/perfil, "Cerrar sesión" queda ahí mismo, sin
  // tener que entrar al Perfil solo para salir (pedido explícito).
  const railProfile = `<div class="railprofile-wrap">
    <button type="button" class="railprofile navitem${perfilActive ? " navitem--active" : ""}" data-profile-menu-toggle aria-haspopup="menu" aria-expanded="false" title="Cuenta">${avatar}<span class="navitem__label">${escapeHtml(admin.username)}</span></button>
    <div class="railprofile-menu" data-profile-menu role="menu">
      <a class="railprofile-menu__item" href="/admin/perfil" role="menuitem">${ICON_EDIT}Editar perfil</a>
      <form method="POST" action="/logout" role="none">
        <button type="submit" class="railprofile-menu__item railprofile-menu__item--danger" role="menuitem">${ICON_LOGOUT}Cerrar sesión</button>
      </form>
    </div>
  </div>`;

  return `<aside class="rail">
    <div class="rail__resize" data-rail-resize aria-hidden="true"></div>
    <div class="rail__top">
      <div class="brand">
        <span class="brand__mark">${escapeHtml(brandName(settings).toUpperCase())}</span>
        <span class="brand__role">Panel</span>
      </div>
      <button type="button" class="rail__toggle" data-rail-toggle aria-label="Contraer u expandir el menú" title="Contraer u expandir el menú">${ICON_COLLAPSE}</button>
    </div>
    <nav class="rail__groups" aria-label="Secciones del panel">
      <div class="navgroup">
        <p class="navgroup__label">Panel</p>
        <ul class="navgroup__items">
          ${item(`/admin`, "Resumen", "resumen", ICON_RESUMEN)}
          ${item(`/admin/conversaciones`, "Conversaciones", "conversaciones", ICON_CONVERSACIONES)}
          ${item(`/admin/leads`, "Leads", "leads", ICON_LEADS)}
          ${item(`/admin/tickets`, "Tickets", "tickets", ICON_TICKETS)}
          ${item(`/admin/analitica`, "Analítica", "analitica", ICON_ANALITICA)}
        </ul>
      </div>
      <div class="laneline"></div>
      <div class="navgroup">
        <p class="navgroup__label">Agente</p>
        <ul class="navgroup__items">
          ${item(`/admin/flujo`, "Flujo", "flujo", ICON_FLUJO)}
          ${item(`/admin/conexiones`, "Conexiones", "conexiones", ICON_CONEXIONES)}
          ${item(`/admin/configuracion`, "Configuración", "configuracion", ICON_CONFIGURACION)}
        </ul>
      </div>
      <div class="laneline"></div>
      <div class="navgroup">
        <p class="navgroup__label">Catálogo</p>
        <ul class="navgroup__items">
          ${item(`/admin/productos`, "Productos", "productos", ICON_PRODUCTOS)}
          ${item(`/admin/pedidos`, "Pedidos", "pedidos", ICON_PEDIDOS)}
          ${item(`/admin/aliados`, "Aliados", "aliados", ICON_ALIADOS)}
          ${item(`/admin/categorias`, "Categorías", "categorias", ICON_CATEGORIAS)}
        </ul>
      </div>
      ${
        isMaster
          ? `<div class="laneline"></div>
      <div class="navgroup">
        <p class="navgroup__label">Equipo</p>
        <ul class="navgroup__items">
          ${item(`/admin/colaboradores`, "Colaboradores", "colaboradores", ICON_COLABORADORES)}
        </ul>
      </div>`
          : ""
      }
    </nav>
    <div class="rail__status">
      <span class="pulse" aria-hidden="true"></span>
      <span class="navitem__label">${escapeHtml(canal)}</span>
    </div>
    ${railProfile}
  </aside>`;
}

function layout(
  title: string,
  settings: SettingsSummary | null,
  body: string,
  active: ActiveSection = null,
  admin?: AdminRecord,
): string {
  const heading = settings ? `${brandName(settings)} — ${title}` : title;
  const rail = settings && admin ? navRail(settings, active, admin) : "";

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
  <div class="shell${settings ? "" : " shell--bare"}">
    ${rail}
    <main>
      ${body}
    </main>
  </div>
  <dialog id="confirm-dialog" class="modal">
    <div class="blockhead"><h2>Confirmar</h2></div>
    <p data-confirm-message></p>
    <div class="formfoot">
      <button type="button" class="btn btn--primary" data-confirm-accept>Confirmar</button>
      <button type="button" class="btn btn--ghost" data-confirm-cancel>Cancelar</button>
    </div>
  </dialog>
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
.shell--bare { grid-template-columns: 1fr; min-height: 100vh; align-items: center; }
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
/* Avatar reutilizado en 3 contextos: rail (30px), fila de tabla de
   Colaboradores (26px, ver .avatar--sm) y el selector grande del propio
   Perfil (64px, ver .avatarpicker). Un solo par de clases en vez de tres
   variantes con nombres distintos. */
.avatar { width: 30px; height: 30px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
.avatar--initial { display: flex; align-items: center; justify-content: center; background: var(--chrome-soft); color: var(--chrome); font-weight: 700; font-family: var(--font-display); font-size: 13px; }
.avatar--sm { width: 26px; height: 26px; font-size: 11px; }
.avatarrow { display: flex; align-items: center; gap: 9px; }
.rail__status { display: flex; align-items: center; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-inset); font-size: 12px; color: var(--ink-muted); white-space: nowrap; overflow: hidden; }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--chrome); box-shadow: 0 0 0 0 var(--chrome-soft); animation: pulse 2.4s ease-out infinite; flex-shrink: 0; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 var(--chrome-soft); } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
@media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
/* Menú de cuenta (pie del rail): un botón, no un link directo — abre un
   popover con "Editar perfil" / "Cerrar sesión" en vez de navegar de
   entrada, para no obligar a pasar por la página de Perfil solo para
   salir. */
.railprofile-wrap { position: relative; }
.railprofile { width: 100%; border: none; background: transparent; font: inherit; text-align: left; }
.railprofile-menu { position: absolute; bottom: calc(100% + 8px); left: 0; right: 0; z-index: 20; display: none; flex-direction: column; gap: 2px; padding: 6px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); }
.railprofile-menu.open { display: flex; }
.railprofile-menu form { display: contents; }
.railprofile-menu__item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 9px 10px; border: none; border-radius: 7px; background: transparent; color: var(--ink); font: inherit; font-size: 13px; text-align: left; text-decoration: none; cursor: pointer; }
.railprofile-menu__item:hover { background: var(--panel-inset); }
.railprofile-menu__item svg { width: 15px; height: 15px; flex-shrink: 0; color: var(--ink-faint); }
.railprofile-menu__item--danger { color: var(--redline); }
.railprofile-menu__item--danger svg { color: var(--redline); }
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
/* Marca de encendido del login (ver renderLoginPage): mismo gesto que
   "arrancar" el tablero — un solo acento decorativo, no se repite en
   ningún otro lado del login para no sobrecargar una pantalla que ya es,
   a propósito, la más simple del panel. */
.loginmark { width: 46px; height: 46px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--panel-inset); border: 1px solid var(--border); color: var(--ignition); margin-bottom: 16px; box-shadow: 0 0 26px -6px var(--ignition-glow); }
.loginmark svg { width: 21px; height: 21px; }
.pagehead { margin-bottom: 28px; }
.pagehead__row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12.5px; font-weight: 600; padding: 9px 15px; border-radius: 7px; border: 1px solid var(--border); background: var(--panel); color: var(--ink); text-decoration: none; cursor: pointer; white-space: nowrap; flex-shrink: 0; }
.btn svg { width: 14px; height: 14px; flex-shrink: 0; }
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
.blockhead--end { justify-content: flex-end; }
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
.pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 20px; border-top: 1px solid var(--border); font-size: 12px; color: var(--ink-muted); }
.pager__controls { display: flex; align-items: center; gap: 12px; }
.pager button { font: inherit; background: var(--panel-inset); border: 1px solid var(--border); border-radius: 6px; width: 26px; height: 26px; color: var(--ink); cursor: pointer; }
.pager button:disabled { opacity: 0.35; cursor: default; }
.pager button:not(:disabled):hover { border-color: var(--border-strong); }
/* Encabezados de columna ordenables (clic = asc/desc) — ver [data-sort-key] en CLIENT_SCRIPT. */
.sortable { cursor: pointer; user-select: none; }
.sortable:hover { color: var(--ink); }
.sortable::after {
  content: ""; display: inline-block; width: 9px; height: 9px; margin-left: 5px; opacity: 0.35;
  vertical-align: -1px; background-color: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 2.5 11 6H5z'/%3E%3Cpath d='M8 13.5 5 10h6z'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 2.5 11 6H5z'/%3E%3Cpath d='M8 13.5 5 10h6z'/%3E%3C/svg%3E") center / contain no-repeat;
}
.sortable--asc::after, .sortable--desc::after { opacity: 1; }
.sortable--asc::after {
  -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 3 12.5 9h-9z'/%3E%3C/svg%3E");
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 3 12.5 9h-9z'/%3E%3C/svg%3E");
}
.sortable--desc::after {
  -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 13 3.5 7h9z'/%3E%3C/svg%3E");
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 13 3.5 7h9z'/%3E%3C/svg%3E");
}
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
.block--narrow { max-width: 640px; }
.field { margin-bottom: 20px; }
.field:last-of-type { margin-bottom: 0; }
.field label { display: block; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-faint); margin-bottom: 8px; font-weight: 600; }
.field select, .field input[type="password"], .field input[type="text"], .field input[type="email"] {
  width: 100%; max-width: 440px; font: inherit; font-size: 13.5px; background: var(--panel-inset);
  border: 1px solid var(--border); border-radius: 9px; padding: 10px 14px; color: var(--ink);
  transition: border-color 140ms ease, background 140ms ease;
}
.field select {
  appearance: none; -webkit-appearance: none; padding-right: 36px; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 6.5 8 10.5 12 6.5' fill='none' stroke='%23889198' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 12px center; background-size: 12px;
  text-overflow: ellipsis;
}
.field select:hover, .field input[type="password"]:hover, .field input[type="text"]:hover, .field input[type="email"]:hover { border-color: var(--border-strong); }
.field select:focus-visible, .field input[type="password"]:focus-visible, .field input[type="text"]:focus-visible, .field input[type="email"]:focus-visible { border-color: var(--chrome); background: var(--panel); }
/* Prefijo de país + número suelto (Colaboradores/Perfil, ver
   buildWhatsappPhone/splitWhatsappPhone): el select y el input comparten
   el mismo ancho máximo de 440px que el resto de los campos, no cada uno
   por separado. */
.phonerow { display: flex; gap: 8px; max-width: 440px; }
.phonerow select { flex: 0 0 168px; width: auto; }
.phonerow input { flex: 1; width: auto; min-width: 0; }
/* Asignación de aliado/categoría por producto (Fase 14, /admin/productos) — dos selects apilados dentro de la celda, el botón Guardar vive en la columna Acciones vía form="...". */
/* Modal ancho para el alta/edición de producto (la lista de variantes no entra en los 440px del modal chico) — ver productoDialogHtml. */
dialog.modal.modal--wide { max-width: 640px; }
/* Modal extra-ancho — solo la previsualización de import CSV, necesita lugar para la miniatura + descripción de cada fila sin scroll horizontal apretado. */
dialog.modal.modal--xwide { max-width: 980px; }
/* Lista dinámica de variantes (SKU/talla/color/precio/stock/activa) del modal de producto — Agregar/Quitar en CLIENT_SCRIPT, sin librería. */
.variantlist { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.variantrow { display: grid; grid-template-columns: 1.3fr 0.8fr 0.8fr 0.9fr 0.7fr auto auto; gap: 6px; align-items: center; }
.variantrow input[type="text"], .variantrow input[type="number"] { width: 100%; font-size: 0.82rem; padding: 6px 8px; }
.variantrow__active { display: flex; align-items: center; gap: 4px; font-size: 0.78rem; white-space: nowrap; }
/* Edición rápida por doble clic (Productos/Aliados, ver data-dblclick-cell en CLIENT_SCRIPT): el campo se ve como texto plano hasta que se hace doble clic — recién ahí se vuelve un input/select interactivo de verdad. */
.dblclick-cell input, .dblclick-cell select {
  width: 100%; border: 1px solid transparent; background: transparent; padding: 2px 4px;
  pointer-events: none; color: inherit; font: inherit;
}
.dblclick-cell.dblclick-active input, .dblclick-cell.dblclick-active select {
  border-color: var(--border); background: var(--bg); pointer-events: auto;
}
.dblclick-cell { cursor: default; }
.dblclick-cell.dblclick-active { cursor: text; }

/* Barra de herramientas con filtros facetados (Productos/Aliados/Categorías) — el select de filtro comparte altura/tipografía con .searchbox, pero es más angosto y no crece (los filtros no deben empujar la búsqueda). */
.tablefilter {
  font: inherit; font-size: 12.5px; background: var(--panel-inset); border: 1px solid var(--border);
  border-radius: 7px; padding: 7px 30px 7px 11px; color: var(--ink); cursor: pointer; flex-shrink: 0;
  appearance: none; -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 6.5 8 10.5 12 6.5' fill='none' stroke='%23889198' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center; background-size: 11px;
}
.tablefilter:hover { border-color: var(--border-strong); }
/* El botón de alta (Productos/Aliados/Categorías) ya no es un botón primario aislado — es un control liviano dentro de la misma barra de filtros, con el mismo peso visual que "cancelar" en un form: abrir el formulario no es la acción que se confirma, crear/guardar adentro sí lo es (ese sigue siendo .btn--primary). */
.btn--add {
  background: transparent; border: 1px dashed var(--border-strong); color: var(--chrome);
  font-weight: 700;
}
.btn--add:hover { background: var(--chrome-soft); border-style: solid; border-color: var(--chrome); }
.btn--add__plus { font-size: 15px; line-height: 1; margin-right: -2px; }
/* Agrupa los botones de acción (ej. "Importar CSV" + "Nuevo producto") al borde derecho de la barra de filtros — el margin-left:auto vive acá, no en .btn--add, para que el grupo entero se empuje junto y no cada botón por separado. */
.tabletools__actions { margin-left: auto; display: flex; align-items: center; gap: 10px; flex-shrink: 0; }

/* Filas expandibles (variantes de un producto) — colapsadas por default, ver data-expand-toggle/data-expand-row en CLIENT_SCRIPT. */
.expandtoggle {
  background: none; border: none; padding: 2px; cursor: pointer; color: var(--ink-faint);
  display: inline-flex; align-items: center; justify-content: center; border-radius: 5px;
  transition: transform 140ms ease, color 140ms ease;
}
.expandtoggle:hover { color: var(--ink); background: var(--panel-inset); }
.expandtoggle svg { width: 13px; height: 13px; transition: transform 140ms ease; }
.expandtoggle--open svg { transform: rotate(90deg); }
tr.expandrow { display: none; background: var(--panel-inset); }
tr.expandrow.is-open { display: table-row; }
tr.expandrow td { padding: 12px 16px 14px 44px; }
.variantgrid { display: flex; flex-direction: column; gap: 6px; }
.variantchip { display: flex; align-items: center; gap: 10px; font-size: 12.5px; padding: 6px 4px; border-bottom: 1px dashed var(--border); }
.variantchip:last-child { border-bottom: none; }
.variantchip__sku { font-family: var(--font-mono); color: var(--ink-faint); min-width: 120px; }
.variantchip__attrs { display: flex; gap: 6px; flex: 1; }
.variantchip__price { font-family: var(--font-mono); min-width: 90px; text-align: right; }
.variantchip__stock { font-family: var(--font-mono); min-width: 70px; text-align: right; }
.variantchip--inactive { opacity: 0.5; }
.tag { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 5px; background: var(--panel); border: 1px solid var(--border); font-size: 11px; color: var(--ink-muted); }
.tag--go { background: var(--go-soft); border-color: var(--go); color: var(--go); }
.tag--bad { background: var(--redline-soft); border-color: var(--redline); color: var(--redline); }
/* Chip de conteo (ej. "12 productos" en Aliados) — usa los mismos colores neutrales que .chip--muted, con el número en mono para escanear la columna de un vistazo. */
.countbadge { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 20px; background: var(--panel-inset); border: 1px solid var(--border); font-size: 12px; color: var(--ink-muted); text-decoration: none; }
.countbadge:hover { border-color: var(--chrome); color: var(--chrome); }
.countbadge strong { font-family: var(--font-mono); color: var(--ink); }
/* padding-left igual al del input de nombre (.dblclick-cell input, 4px) — sin esto el nombre y el "aliado · categoría" de abajo quedan desalineados horizontalmente. */
.rowmeta { font-size: 11.5px; color: var(--ink-faint); margin-top: 2px; padding-left: 4px; }

/*
 * Previsualización editable de la carga por CSV — una card por producto
 * (no una fila de grid con scroll horizontal): la miniatura siempre va
 * primero y siempre visible, sea la imagen nueva del CSV (editable, fila
 * "Nuevo") o la imagen ya guardada del producto (solo lectura, fila
 * "Actualiza" — la carga masiva nunca reasigna imagen/descripción de un
 * producto existente, pero mostrarla en solo lectura evita que parezca
 * que la funcionalidad no está, que es justo el reporte que motivó este
 * rediseño).
 */
.importpreview { display: flex; flex-direction: column; gap: 10px; max-height: 56vh; overflow-y: auto; margin: 16px 0; padding-right: 6px; }
.importrow { display: flex; gap: 14px; padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel-inset); }
.importrow--crear { border-color: var(--go); }
.importrow--error { border-color: var(--redline); }
.importrow__thumb { width: 60px; height: 60px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); background: var(--panel); flex-shrink: 0; }
.importrow__thumb--empty { display: flex; align-items: center; justify-content: center; color: var(--ink-faint); }
.importrow__thumb--empty svg { width: 20px; height: 20px; }
.importrow__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.importrow__head { display: flex; align-items: center; gap: 8px; }
.importrow__head input { flex: 1; font-weight: 600; font-size: 13px; padding: 6px 8px; }
.importrow__fields { display: flex; flex-wrap: wrap; gap: 8px; }
.importrow__fields input, .importrow__fields select { font-size: 12.5px; padding: 6px 8px; }
.importrow__fields input[readonly] { background: var(--panel); color: var(--ink-faint); }
.importrow__field--sku { flex: 0 1 118px; }
.importrow__field--price { flex: 0 1 100px; }
.importrow__field--stock { flex: 0 1 76px; }
.importrow__field--attr { flex: 0 1 76px; }
.importrow__field--category { flex: 1 1 170px; }
.importrow__description { font: inherit; font-size: 12.5px; padding: 7px 9px; resize: vertical; min-height: 36px; width: 100%; }
.importrow__description[readonly] { background: var(--panel); color: var(--ink-faint); resize: none; }
.importrow__context { font-size: 11.5px; color: var(--ink-faint); }
.importrow__context--error { color: var(--redline); }

/* Árbol de categorías — indentación real + línea de guía por profundidad, en vez de la tabla plana con inputs siempre visibles de antes. */
.cattree__row td:first-child { position: relative; }
.cattree__branch { display: flex; align-items: center; gap: 6px; }
.cattree__guide { flex-shrink: 0; height: 20px; border-left: 1px dashed var(--border-strong); }
.cattree__toggle { background: none; border: none; padding: 2px; cursor: pointer; color: var(--ink-faint); display: inline-flex; flex-shrink: 0; border-radius: 5px; }
.cattree__toggle:hover { color: var(--ink); background: var(--panel-inset); }
.cattree__toggle svg { width: 12px; height: 12px; transition: transform 140ms ease; transform: rotate(90deg); }
.cattree__row--collapsed .cattree__toggle svg { transform: rotate(0deg); }
.cattree__spacer { display: inline-block; width: 18px; flex-shrink: 0; }
.cattree__row--dim { opacity: 0.4; }
.cattree__name { font-weight: 600; }

/* Switch de Activar/Desactivar (Aliados/Categorías) — reemplaza los dos botones de texto condicionales ("Activar"/"Desactivar") por un único control compacto, mismo criterio de color que ya usaba el botón (verde = activo, rojo = inactivo) pero sin competir en ancho con Guardar/Editar en la columna de Acciones. */
.toggleswitch { background: none; border: none; padding: 2px; cursor: pointer; display: inline-flex; align-items: center; flex-shrink: 0; }
.toggleswitch__track {
  width: 34px; height: 18px; border-radius: 10px; position: relative; flex-shrink: 0;
  background: var(--redline-soft); border: 1px solid var(--redline);
  transition: background 140ms ease, border-color 140ms ease;
}
.toggleswitch--on .toggleswitch__track { background: var(--go-soft); border-color: var(--go); }
.toggleswitch__knob {
  position: absolute; top: 1px; left: 1px; width: 14px; height: 14px; border-radius: 50%;
  background: var(--redline); transition: transform 140ms ease, background 140ms ease;
}
.toggleswitch--on .toggleswitch__knob { transform: translateX(16px); background: var(--go); }
.toggleswitch:hover .toggleswitch__track { filter: brightness(1.15); }
.toggleswitch:focus-visible { outline: 2px solid var(--chrome); outline-offset: 2px; border-radius: 10px; }
/* Columna Estado con el switch — el texto acompaña el color del track (verde/gris) en vez de vivir en un chip aparte, sin duplicar la señal de estado dos veces en la misma fila. */
.statustoggle { display: flex; align-items: center; gap: 8px; }
.statustoggle__label { font-size: 12.5px; font-weight: 600; color: var(--go); }
.statustoggle__label--off { color: var(--ink-faint); font-weight: 500; }
/* Validación en tiempo real (username/correo/contraseña, ver
   data-validate en el JS): la "luz" reutiliza literalmente los colores de
   estado del tablero (--go/--redline) que ya usa el resto del panel (ver
   .chip--go/.chip--redline) en vez de inventar una paleta de validación
   aparte — mismo lenguaje visual, un semáforo más en el tablero. */
.fieldcheck { position: relative; max-width: 440px; }
.fieldcheck input { padding-right: 34px !important; }
.fieldcheck__light { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); width: 8px; height: 8px; border-radius: 50%; background: var(--border-strong); transition: background 160ms ease, box-shadow 160ms ease; pointer-events: none; }
.fieldcheck__light--ok { background: var(--go); box-shadow: 0 0 0 3px var(--go-soft); }
.fieldcheck__light--bad { background: var(--redline); box-shadow: 0 0 0 3px var(--redline-soft); }
.fieldcheck__msg { margin: 6px 0 0; font-size: 11.5px; color: var(--ink-faint); transition: color 140ms ease; }
.fieldcheck__msg--ok { color: var(--go); }
.fieldcheck__msg--bad { color: var(--redline); }
.currency-form { display: flex; align-items: center; gap: 8px; }
.currency-form label { font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-faint); font-weight: 600; }
.currency-form select {
  appearance: none; -webkit-appearance: none; font: inherit; font-size: 13px; background: var(--panel-inset);
  border: 1px solid var(--border); border-radius: 9px; padding: 8px 32px 8px 12px; color: var(--ink); cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 6.5 8 10.5 12 6.5' fill='none' stroke='%23889198' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center; background-size: 12px;
}
.currency-form select:hover { border-color: var(--border-strong); }
.currency-form select:focus-visible { border-color: var(--chrome); background: var(--panel); }
.field select:disabled { opacity: 0.5; cursor: default; }
.field input[type="password"]::placeholder { color: var(--ink-faint); }
.field .hint { margin: 8px 0 0; font-size: 12px; color: var(--ink-faint); max-width: 440px; }
.formfoot { display: flex; align-items: center; gap: 12px; margin-top: 22px; }
.btn--primary { background: var(--chrome); border-color: var(--chrome); color: var(--bg); font-weight: 700; }
.btn--primary:hover { filter: brightness(1.08); border-color: var(--chrome); background: var(--chrome); }
.btn--ghost { background: transparent; }
.btn--ghost:hover { background: var(--panel-inset); }
/* Color = la acción que el botón va a ejecutar, no el estado actual (ver
   estadoForm en renderColaboradoresPage) — mismo lenguaje de --go/--redline
   que ya usan los chips Activo/Inactivo. */
.btn--danger { background: var(--redline); border-color: var(--redline); color: var(--bg); font-weight: 700; }
.btn--danger:hover { filter: brightness(1.08); }
.btn--go { background: var(--go); border-color: var(--go); color: var(--bg); font-weight: 700; }
.btn--go:hover { filter: brightness(1.08); }
.btn--icon { width: 34px; height: 34px; padding: 0; justify-content: center; flex-shrink: 0; }
.btn--icon svg { width: 15px; height: 15px; }
.btn--sm { padding: 6px 11px; font-size: 11.5px; }
.permform { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
/* Columna "Acciones" de Colaboradores: agrupa el botón Guardar de
   permisos (conectado por atributo form="..." a un <form> en la columna
   de Notificaciones, ver renderColaboradoresPage) + Activar/Desactivar,
   para que todos los botones de la fila queden juntos al final. */
.rowactions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.permcheck { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-muted); white-space: nowrap; }
.banner { padding: 12px 16px; border-radius: 8px; font-size: 13px; margin-bottom: 20px; }
.banner--ok { background: var(--go-soft); color: var(--go); }
.banner--error { background: var(--redline-soft); color: var(--redline); }
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
.emptystate { padding: 52px 24px; text-align: center; }
.emptystate__icon { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; margin: 0 auto 14px; color: var(--ink-faint); }
.emptystate__title { font-family: var(--font-display); font-weight: 700; font-size: 15px; color: var(--ink); margin: 0 0 6px; }
.emptystate__desc { font-size: 12.5px; color: var(--ink-faint); max-width: 380px; margin: 0 auto; line-height: 1.5; }
td .emptystate { padding: 34px 20px; }
.choicegrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
.choice { position: relative; display: block; }
.choice input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; }
.choice__card { display: flex; flex-direction: column; gap: 7px; height: 100%; padding: 13px 15px; border: 1px solid var(--border); border-radius: 9px; background: var(--panel-inset); transition: border-color 140ms ease, background 140ms ease, box-shadow 140ms ease; text-transform: none; letter-spacing: normal; font-weight: 400; }
.choice__icon { width: 18px; height: 18px; color: var(--ink-faint); transition: color 140ms ease; }
.choice__title { font-weight: 700; font-size: 13px; color: var(--ink); }
.choice__desc { font-size: 11.5px; color: var(--ink-muted); line-height: 1.4; }
.choice:hover .choice__card { border-color: var(--border-strong); }
.choice input:checked + .choice__card { border-color: var(--ignition); background: var(--panel); box-shadow: 0 0 0 1px var(--ignition), 0 0 16px -7px var(--ignition-glow); }
.choice input:checked + .choice__card .choice__icon { color: var(--ignition); }
.choice input:focus-visible + .choice__card { outline: 2px solid var(--chrome); outline-offset: 2px; }
.connection__titlewrap { display: flex; align-items: center; gap: 12px; }
.connection__icon { width: 34px; height: 34px; flex-shrink: 0; border-radius: 9px; background: var(--panel-inset); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; color: var(--ink-muted); }
.connection--live { box-shadow: var(--shadow), 0 0 0 1px var(--go), 0 0 24px -9px var(--go); }
.connection--live .connection__icon { color: var(--go); border-color: var(--go); }
.flownode__badge { display: inline-flex; align-items: center; justify-content: center; width: 21px; height: 21px; border-radius: 6px; background: var(--panel-inset); border: 1px solid var(--border); color: var(--chrome); margin-right: 8px; vertical-align: -5px; }
.flownode__badge svg { width: 12px; height: 12px; }
.flowsatellites { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
@media (max-width: 480px) { .flowsatellites { grid-template-columns: 1fr; } }
.flowsat { position: relative; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-inset); padding: 9px 12px 10px; }
.flowsat::before { content: ""; position: absolute; top: -12px; left: 18px; width: 1px; height: 11px; border-left: 1px dashed var(--border-strong); }
.flowsat__label { display: block; font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--chrome); font-weight: 600; margin-bottom: 3px; }
.flowsat__value { font-size: 12.5px; }
.flowtools { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; background: var(--panel-inset); }
.flowtools__label { display: flex; align-items: center; gap: 6px; font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); font-weight: 600; margin-bottom: 9px; }
.flowtools__label svg { width: 12px; height: 12px; }
dialog.modal { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); padding: 22px 24px; max-width: 440px; width: calc(100% - 40px); }
dialog.modal::backdrop { background: rgba(0, 0, 0, 0.4); }
/* Avatar grande y clickeable del Perfil (a diferencia del <input type=file>
   crudo de antes): el círculo entero es el disparador, el archivo real
   queda oculto (ver data-avatar-input) — patrón más reconocible que un
   botón "Choose file" nativo suelto en medio del form. */
.avatarpicker { position: relative; display: inline-flex; width: 72px; height: 72px; border: none; padding: 0; background: none; cursor: pointer; border-radius: 50%; }
.avatarpicker .avatar { width: 72px; height: 72px; font-size: 22px; border: 1px solid var(--border); }
.avatarpicker__badge { position: absolute; right: -2px; bottom: -2px; width: 24px; height: 24px; border-radius: 50%; background: var(--chrome); color: var(--bg); display: flex; align-items: center; justify-content: center; border: 2px solid var(--panel); }
.avatarpicker__badge svg { width: 12px; height: 12px; }
.avatarpicker:hover .avatar { filter: brightness(0.92); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
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
    var chartFormat = wrap.getAttribute("data-format") || "int";
    var moneySymbol = wrap.getAttribute("data-symbol") || "$";
    var moneyDecimals = parseInt(wrap.getAttribute("data-decimals") || "2", 10);
    var moneySuffix = wrap.getAttribute("data-money-suffix") || "";
    function formatValor(v) {
      if (chartFormat === "money") {
        // Mismo criterio que formatMoney en el servidor: un monto real
        // menor a 1 unidad de la moneda no debe verse como si fuera cero.
        var decimals = (v > 0 && v < 1) ? Math.max(moneyDecimals, 4) : moneyDecimals;
        var num = moneySuffix ? v.toLocaleString("es-CO", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : v.toFixed(decimals);
        return moneySymbol + num + moneySuffix;
      }
      return String(v);
    }
    var W = 900, H = 220, padL = 8, padR = 8, padT = 26, padB = 28;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var maxV = Math.max(chartFormat === "money" ? 0.0001 : 1, Math.max.apply(null, data.map(function (d) { return d.valor; })));

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
    var peakLabel = '<text class="chart-peaklabel" x="' + x(peakIdx) + '" y="' + (y(data[peakIdx].valor) - 12) + '">' + formatValor(data[peakIdx].valor) + "</text>";
    var hitCols = data.map(function (d, i) {
      var cw = plotW / data.length, cx0 = padL + i * cw;
      return '<rect class="chart-hit" data-i="' + i + '" x="' + cx0 + '" y="0" width="' + cw + '" height="' + H + '"></rect>';
    }).join("");

    var ariaLabel = wrap.getAttribute("data-aria-label") || "Mensajes por dia, ultimos 7 dias";
    wrap.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="' + ariaLabel + '">'
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
      tooltip.innerHTML = d.label + " &nbsp; <b>" + formatValor(d.valor) + "</b>" + (chartFormat === "money" ? "" : " msj");
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

  /* ---------- tablas: búsqueda + filtros + paginado en el cliente ---------- */
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
    // Filtros facetados (ej. Aliado/Categoría en Productos, Estado en
    // Aliados) — cada select data-table-filter data-filter-key="ally"
    // se combina con la búsqueda de texto vía AND, comparando su valor
    // contra el atributo data-filter-ally de cada fila. "" = sin filtro.
    var filterSelects = Array.prototype.slice.call(wrap.querySelectorAll("[data-table-filter]"));
    // Encabezados ordenables (ver .sortable en STYLE_BLOCK) — cada <th
    // data-sort-key="precio"> compara el atributo data-sort-precio de cada
    // fila. Reordena los <tr> reales en el DOM (no solo su display), así
    // la paginación de arriba sigue tomando las primeras N filas visibles
    // en el orden correcto.
    var sortHeaders = Array.prototype.slice.call(wrap.querySelectorAll("[data-sort-key]"));
    var sortKey = null;
    var sortDir = 1;
    var page = 1;

    function applySort() {
      if (!sortKey) return;
      rows.sort(function (a, b) {
        var av = a.getAttribute("data-sort-" + sortKey) || "";
        var bv = b.getAttribute("data-sort-" + sortKey) || "";
        var an = parseFloat(av);
        var bn = parseFloat(bv);
        var cmp;
        if (av !== "" && bv !== "" && !isNaN(an) && !isNaN(bn)) {
          cmp = an - bn;
        } else {
          cmp = av.localeCompare(bv, "es", { sensitivity: "base" });
        }
        return cmp * sortDir;
      });
      rows.forEach(function (tr) {
        var expandId = tr.getAttribute("data-expand-target");
        var expandRow = expandId ? document.getElementById(expandId) : null;
        tbody.appendChild(tr);
        if (expandRow) tbody.appendChild(expandRow);
      });
    }
    sortHeaders.forEach(function (th) {
      th.addEventListener("click", function () {
        var key = th.getAttribute("data-sort-key");
        sortDir = sortKey === key ? sortDir * -1 : 1;
        sortKey = key;
        sortHeaders.forEach(function (h) { h.classList.remove("sortable--asc", "sortable--desc"); });
        th.classList.add(sortDir === 1 ? "sortable--asc" : "sortable--desc");
        page = 1;
        applySort();
        apply();
      });
    });

    function apply() {
      var q = (searchInput.value || "").trim().toLowerCase();
      var matched = rows.filter(function (tr) {
        if (q && tr.getAttribute("data-search").indexOf(q) === -1) return false;
        for (var i = 0; i < filterSelects.length; i++) {
          var sel = filterSelects[i];
          var val = sel.value;
          if (!val) continue;
          if (tr.getAttribute("data-filter-" + sel.getAttribute("data-filter-key")) !== val) return false;
        }
        return true;
      });
      var pages = Math.max(1, Math.ceil(matched.length / pageSize));
      if (page > pages) page = pages;
      var start = (page - 1) * pageSize;
      rows.forEach(function (tr) {
        tr.style.display = "none";
        // Si la fila tenía su detalle de variantes abierto, se colapsa al
        // filtrar/paginar — evita dejar la fila de detalle visible sin su
        // fila dueña (que puede haber cambiado de página).
        var expandId = tr.getAttribute("data-expand-target");
        var expandRow = expandId ? document.getElementById(expandId) : null;
        if (expandRow) expandRow.classList.remove("is-open");
      });
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
    filterSelects.forEach(function (sel) {
      sel.addEventListener("change", function () { page = 1; apply(); });
    });
    if (prevBtn) prevBtn.addEventListener("click", function () { if (page > 1) { page--; apply(); } });
    if (nextBtn) nextBtn.addEventListener("click", function () { page++; apply(); });
    apply();
  });

  /* ---------- filas expandibles (ej. variantes de un producto) ---------- */
  document.addEventListener("click", function (event) {
    var toggle = event.target.closest && event.target.closest("[data-expand-toggle]");
    if (!toggle) return;
    var targetRow = document.getElementById(toggle.getAttribute("data-expand-toggle"));
    if (!targetRow) return;
    var isOpen = targetRow.classList.toggle("is-open");
    toggle.classList.toggle("expandtoggle--open", isOpen);
    toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });

  /* ---------- árbol de categorías: colapsar/expandir ramas ---------- */
  document.querySelectorAll("[data-cattree]").forEach(function (tree) {
    var rows = Array.prototype.slice.call(tree.querySelectorAll("[data-cat-row]"));
    function descendants(id) {
      var direct = rows.filter(function (r) { return r.getAttribute("data-cat-parent") === id; });
      var all = direct.slice();
      direct.forEach(function (r) {
        all = all.concat(descendants(r.getAttribute("data-cat-row")));
      });
      return all;
    }
    tree.querySelectorAll("[data-cat-toggle]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var row = btn.closest("[data-cat-row]");
        var id = row.getAttribute("data-cat-row");
        var collapsed = row.classList.toggle("cattree__row--collapsed");
        descendants(id).forEach(function (r) {
          r.style.display = collapsed ? "none" : "";
        });
      });
    });

    // Búsqueda de texto + filtro de estado (Activas/Inactivas/Todas) —
    // atenúan en vez de esconder: una categoría inactiva puede seguir
    // teniendo hijas activas, esconderla rompería la jerarquía visible.
    var searchInput = tree.parentElement.querySelector("[data-cattree-search]");
    var estadoFilter = tree.parentElement.querySelector("[data-cattree-estado]");
    function applyDim() {
      var q = searchInput ? (searchInput.value || "").trim().toLowerCase() : "";
      var val = estadoFilter ? estadoFilter.value : "";
      rows.forEach(function (r) {
        var active = r.getAttribute("data-cat-active") === "true";
        var estadoDim = (val === "activas" && !active) || (val === "inactivas" && active);
        var searchDim = q && r.getAttribute("data-cat-search").indexOf(q) === -1;
        r.classList.toggle("cattree__row--dim", estadoDim || searchDim);
      });
    }
    if (searchInput) searchInput.addEventListener("input", applyDim);
    if (estadoFilter) estadoFilter.addEventListener("change", applyDim);
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

  /* ---------- confirmación con la modal del panel (pausar el bot, activar/desactivar aliados y categorías) — reemplaza window.confirm() nativo por #confirm-dialog, mismo estilo que el resto de los diálogos ---------- */
  var confirmDialog = document.getElementById("confirm-dialog");
  if (confirmDialog) {
    var pendingConfirmForm = null;
    document.querySelectorAll("[data-confirm]").forEach(function (form) {
      form.addEventListener("submit", function (evt) {
        evt.preventDefault();
        pendingConfirmForm = form;
        var msgEl = confirmDialog.querySelector("[data-confirm-message]");
        if (msgEl) msgEl.textContent = form.getAttribute("data-confirm");
        confirmDialog.showModal();
      });
    });
    var confirmAccept = confirmDialog.querySelector("[data-confirm-accept]");
    if (confirmAccept) {
      confirmAccept.addEventListener("click", function () {
        confirmDialog.close();
        if (pendingConfirmForm) {
          pendingConfirmForm.submit();
          pendingConfirmForm = null;
        }
      });
    }
    var confirmCancel = confirmDialog.querySelector("[data-confirm-cancel]");
    if (confirmCancel) {
      confirmCancel.addEventListener("click", function () {
        confirmDialog.close();
        pendingConfirmForm = null;
      });
    }
  }

  /* ---------- Configuración: filtra el selector de Modelo según el Proveedor elegido ---------- */
  var providerSelect = document.querySelector("[data-provider-select]");
  if (providerSelect) {
    var catalog = null;
    var catalogEl = document.getElementById("llm-catalog-data");
    if (catalogEl) {
      try { catalog = JSON.parse(catalogEl.textContent); } catch (e) { catalog = null; }
    }
    var modelSelect = document.querySelector("[data-model-select]");
    var apiKeyInput = document.querySelector("[data-apikey-input]");
    var routingModeSelect = document.querySelector("[data-routing-mode-select]");
    var initialModel = modelSelect.getAttribute("data-initial-model") || "";

    function placeholderOption(text) {
      modelSelect.innerHTML = "";
      modelSelect.disabled = true;
      var opt = document.createElement("option");
      opt.value = "";
      opt.textContent = text;
      modelSelect.appendChild(opt);
    }

    function renderModelOptions() {
      var entry = catalog ? catalog[providerSelect.value] : null;
      if (!entry) {
        placeholderOption("— usa el default de la plataforma —");
        if (apiKeyInput) apiKeyInput.placeholder = "";
        return;
      }
      if (apiKeyInput) apiKeyInput.placeholder = entry.keyPlaceholder || "";
      // "Cerebro del bot" (ver ADR-023): en automático, el modelo lo
      // elige el resolver por turno según la dificultad del mensaje — el
      // select de Modelo no aplica, se deshabilita.
      if (routingModeSelect && routingModeSelect.value === "auto_dificultad") {
        placeholderOption("— se elige automáticamente según la dificultad del mensaje —");
        return;
      }
      modelSelect.innerHTML = "";
      modelSelect.disabled = false;
      entry.models.forEach(function (m) {
        var opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label;
        if (m.id === initialModel) opt.selected = true;
        modelSelect.appendChild(opt);
      });
    }
    providerSelect.addEventListener("change", renderModelOptions);
    if (routingModeSelect) routingModeSelect.addEventListener("change", renderModelOptions);
    renderModelOptions();
  }

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

  /* ---------- diálogos modales (ej. "+ Agregar colaborador" en Colaboradores) ---------- */
  document.querySelectorAll("[data-open-dialog]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var dialog = document.getElementById(btn.getAttribute("data-open-dialog"));
      if (dialog) dialog.showModal();
    });
  });
  document.querySelectorAll("[data-close-dialog]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var dialog = document.getElementById(btn.getAttribute("data-close-dialog"));
      if (dialog) dialog.close();
    });
  });

  /* ---------- edición rápida por doble clic (Productos/Aliados, ver .dblclick-cell en STYLE_BLOCK) ---------- */
  document.querySelectorAll(".dblclick-cell").forEach(function (cell) {
    cell.addEventListener("dblclick", function () {
      cell.classList.add("dblclick-active");
      var field = cell.querySelector("input, select");
      if (field) field.focus();
    });
  });

  /* ---------- variantes dinámicas del modal de producto: agregar/quitar fila ---------- */
  document.querySelectorAll("[data-add-variant-row]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var dialog = btn.closest("dialog");
      if (!dialog) return;
      var template = dialog.querySelector("[data-variant-row-template]");
      var list = dialog.querySelector("[data-variant-list]");
      if (!template || !list) return;
      list.appendChild(template.content.cloneNode(true));
    });
  });
  document.addEventListener("click", function (event) {
    var removeBtn = event.target.closest && event.target.closest("[data-remove-variant-row]");
    if (!removeBtn) return;
    var row = removeBtn.closest("[data-variant-row]");
    var list = removeBtn.closest("[data-variant-list]");
    if (row && list && list.querySelectorAll("[data-variant-row]").length > 1) {
      row.remove();
    }
  });
  document.addEventListener("change", function (event) {
    if (event.target.matches && event.target.matches("[data-active-toggle]")) {
      var hidden = event.target.parentElement.querySelector('input[name="active[]"]');
      if (hidden) hidden.value = event.target.checked ? "true" : "false";
    }
  });

  /* ---------- avatar del Perfil: círculo clickeable -> input file oculto -> data URL ---------- */
  var avatarTrigger = document.querySelector("[data-avatar-trigger]");
  var avatarInput = document.querySelector("[data-avatar-input]");
  if (avatarTrigger && avatarInput) {
    avatarTrigger.addEventListener("click", function () { avatarInput.click(); });
  }
  if (avatarInput) {
    avatarInput.addEventListener("change", function () {
      var file = avatarInput.files && avatarInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var hidden = document.querySelector("[data-avatar-hidden]");
        if (hidden) hidden.value = reader.result;
        // El preview puede ser un <span> (iniciales, sin avatar todavía) o
        // un <img> (ya tenía uno) — se reemplaza siempre por un <img>
        // fresco en vez de asumir cuál de los dos es, para no fallar
        // seteando ".src" sobre un <span>.
        var preview = document.querySelector("[data-avatar-preview]");
        if (preview) {
          var img = document.createElement("img");
          img.className = "avatar";
          img.alt = "";
          img.setAttribute("data-avatar-preview", "");
          img.src = reader.result;
          preview.replaceWith(img);
        }
      };
      reader.readAsDataURL(file);
    });
  }

  /* ---------- Importar productos: archivo CSV -> texto plano en campo oculto (mismo patrón que el avatar, sin @fastify/multipart) ---------- */
  var csvInput = document.querySelector("[data-csv-input]");
  if (csvInput) {
    csvInput.addEventListener("change", function () {
      var file = csvInput.files && csvInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var hidden = document.querySelector("[data-csv-hidden]");
        if (hidden) hidden.value = reader.result;
      };
      reader.readAsText(file);
    });
  }

  /* ---------- Importar productos: previsualización editable antes de confirmar la carga ---------- */
  (function () {
    var previewBtn = document.querySelector("[data-import-preview-btn]");
    if (!previewBtn) return;

    function escapeForAttr(value) {
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;");
    }

    // Árbol de categorías embebido por el servidor (ver importarCsvPreviewDialogHtml)
    // — se arma una vez el <select> de categoría de cada fila nueva, sin otro round-trip.
    var categoryTreeEl = document.querySelector("[data-import-categories]");
    var categoryTree = [];
    try {
      categoryTree = categoryTreeEl ? JSON.parse(categoryTreeEl.textContent) : [];
    } catch (e) {
      categoryTree = [];
    }
    function categorySelectHtml() {
      var options = categoryTree
        .map(function (c) {
          return '<option value="' + escapeForAttr(c.id) + '">' + new Array(c.depth + 1).join("— ") + escapeForAttr(c.name) + "</option>";
        })
        .join("");
      return (
        '<select name="categoryId[]" class="importrow__field--category"><option value="">Sin categoría</option>' +
        options +
        "</select>"
      );
    }

    // Ícono placeholder cuando todavía no hay ninguna imagen que mostrar
    // (fila "Error" sin SKU resuelto todavía).
    var THUMB_PLACEHOLDER_ICON =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6"/><circle cx="5.4" cy="6" r="1" fill="currentColor" stroke="none"/><path d="M2.2 11.6 5.8 8l2.6 2.4L11 8l2.8 3"/></svg>';

    function thumbHtml(url) {
      var has = !!(url && url.trim());
      return (
        '<img class="importrow__thumb" data-import-thumb src="' + escapeForAttr(url) + '" alt="" loading="lazy"' +
        (has ? "" : ' style="display:none"') + ">" +
        '<div class="importrow__thumb importrow__thumb--empty" data-import-thumb-empty' +
        (has ? ' style="display:none"' : "") + ">" + THUMB_PLACEHOLDER_ICON + "</div>"
      );
    }

    // Delegado sobre el contenedor (no sobre cada fila, que se reemplaza
    // entero en cada renderImportPreview) — si el admin corrige la URL de
    // la imagen en la previsualización, la miniatura de al lado se
    // actualiza en vivo.
    var previewBody = document.querySelector("[data-import-preview-body]");
    if (previewBody) {
      previewBody.addEventListener("input", function (event) {
        if (!event.target.matches("[data-import-image-input]")) return;
        var row = event.target.closest(".importrow");
        var img = row ? row.querySelector("[data-import-thumb]") : null;
        var empty = row ? row.querySelector("[data-import-thumb-empty]") : null;
        var val = event.target.value.trim();
        if (img) { img.src = val; img.style.display = val ? "" : "none"; }
        if (empty) { empty.style.display = val ? "none" : ""; }
      });
    }

    function renderImportPreview(rows, allyId) {
      var body = document.querySelector("[data-import-preview-body]");
      var allyHidden = document.querySelector("[data-import-ally-hidden]");
      var summary = document.querySelector("[data-import-summary]");
      if (allyHidden) allyHidden.value = allyId;
      if (!body) return;

      var creando = rows.filter(function (r) { return r.kind === "crear"; }).length;
      var actualizando = rows.filter(function (r) { return r.kind === "actualizar"; }).length;
      var conError = rows.filter(function (r) { return r.kind === "error"; }).length;
      if (summary) {
        summary.textContent =
          creando + " producto(s) nuevo(s) · " + actualizando + " actualización(es) de stock" +
          (conError ? " · " + conError + " fila(s) con error" : "") +
          " — elegí la categoría de cada producto nuevo y revisá/editá lo que haga falta antes de confirmar. Si varias filas nuevas comparten nombre, se usa la categoría de la primera.";
      }

      body.innerHTML = rows
        .map(function (row) {
          var isCrear = row.kind === "crear";
          var isActualizar = row.kind === "actualizar";
          var readonly = isActualizar ? "readonly" : "";

          var badge = isCrear
            ? '<span class="tag tag--go">Nuevo</span>'
            : isActualizar
              ? '<span class="tag">Actualiza</span>'
              : '<span class="tag tag--bad">Error</span>';

          // La imagen de una fila "Actualiza" es la ya guardada del
          // producto (informativa, nunca se reasigna); la de "Nuevo" es
          // la del CSV, editable más abajo.
          var thumbUrl = isCrear ? row.imageUrl : isActualizar ? row.existingImageUrl || "" : "";
          var thumb = thumbHtml(thumbUrl);

          var categoryField = isCrear
            ? categorySelectHtml()
            : '<input type="hidden" name="categoryId[]" value="">';

          var descriptionField = isCrear
            ? '<textarea class="importrow__description" name="description[]" placeholder="Descripción (opcional)" rows="2">' +
              escapeForAttr(row.description) + "</textarea>"
            : isActualizar
              ? '<textarea class="importrow__description" rows="2" readonly>' +
                escapeForAttr(row.existingDescription || "Sin descripción guardada.") + "</textarea>" +
                '<input type="hidden" name="description[]" value="">'
              : '<input type="hidden" name="description[]" value="">';

          var imageUrlField = isCrear
            ? '<input type="text" class="importrow__imageurl" name="imageUrl[]" data-import-image-input value="' +
              escapeForAttr(row.imageUrl) + '" placeholder="URL de la imagen (opcional)">'
            : '<input type="hidden" name="imageUrl[]" value="">';

          var context = isActualizar
            ? '<span class="importrow__context">Precio y stock actuales: $' + escapeForAttr(row.existingPrice) +
              " · stock " + escapeForAttr(row.existingStock) +
              ". El nombre, la categoría, la descripción y la imagen no cambian por esta carga.</span>"
            : row.errorMessage
              ? '<span class="importrow__context importrow__context--error">' + escapeForAttr(row.errorMessage) + "</span>"
              : "";

          return (
            '<div class="importrow importrow--' + row.kind + '">' +
            thumb +
            '<div class="importrow__body">' +
            '<div class="importrow__head">' +
            badge +
            '<input type="text" name="name[]" value="' + escapeForAttr(row.name) + '" placeholder="Nombre" ' + readonly + ">" +
            "</div>" +
            '<div class="importrow__fields">' +
            '<input type="text" name="sku[]" class="mono importrow__field--sku" value="' + escapeForAttr(row.sku) + '" placeholder="SKU">' +
            '<input type="number" name="price[]" class="importrow__field--price" value="' + escapeForAttr(row.price) + '" placeholder="Precio">' +
            '<input type="number" name="stock[]" class="importrow__field--stock" value="' + escapeForAttr(row.stock) + '" placeholder="Stock">' +
            '<input type="text" name="talla[]" class="importrow__field--attr" value="' + escapeForAttr(row.talla) + '" placeholder="Talla" ' + readonly + ">" +
            '<input type="text" name="color[]" class="importrow__field--attr" value="' + escapeForAttr(row.color) + '" placeholder="Color" ' + readonly + ">" +
            categoryField +
            "</div>" +
            descriptionField +
            imageUrlField +
            context +
            "</div>" +
            "</div>"
          );
        })
        .join("");
    }

    previewBtn.addEventListener("click", function () {
      var allySelect = document.querySelector("[data-import-ally-select]");
      var csvHidden = document.querySelector("[data-csv-hidden]");
      var errorEl = document.querySelector("[data-import-step1-error]");
      if (errorEl) errorEl.textContent = "";
      if (!csvHidden || !csvHidden.value) {
        if (errorEl) errorEl.textContent = "Elegí un archivo CSV primero.";
        return;
      }
      previewBtn.disabled = true;
      previewBtn.textContent = "Analizando…";
      fetch("/admin/productos/importar/previsualizar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText: csvHidden.value }),
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          previewBtn.disabled = false;
          previewBtn.textContent = "Previsualizar";
          if (!data.ok) {
            if (errorEl) errorEl.textContent = data.error || "No se pudo leer el archivo.";
            return;
          }
          renderImportPreview(data.rows, allySelect ? allySelect.value : "");
          var step1Dialog = document.getElementById("importar-csv-dialog");
          var previewDialog = document.getElementById("importar-csv-preview-dialog");
          if (step1Dialog) step1Dialog.close();
          if (previewDialog) previewDialog.showModal();
        })
        .catch(function () {
          previewBtn.disabled = false;
          previewBtn.textContent = "Previsualizar";
          if (errorEl) errorEl.textContent = "No se pudo analizar el archivo — probá de nuevo.";
        });
    });
  })();

  /* ---------- Reporte del asistente: "Cada cuántos días" solo se ve con frecuencia "Personalizado" ---------- */
  var frecuenciaGrid = document.querySelector("[data-frecuencia-grid]");
  var diasWrap = document.querySelector("[data-dias-personalizados-wrap]");
  if (frecuenciaGrid && diasWrap) {
    frecuenciaGrid.querySelectorAll('input[name="frecuencia"]').forEach(function (radio) {
      radio.addEventListener("change", function () {
        diasWrap.style.display = radio.value === "personalizado" && radio.checked ? "" : "none";
      });
    });
  }

  /* ---------- menú de cuenta (rail): abrir/cerrar, click afuera, Escape ---------- */
  var profileToggle = document.querySelector("[data-profile-menu-toggle]");
  var profileMenu = document.querySelector("[data-profile-menu]");
  if (profileToggle && profileMenu) {
    var closeProfileMenu = function () {
      profileMenu.classList.remove("open");
      profileToggle.setAttribute("aria-expanded", "false");
    };
    profileToggle.addEventListener("click", function (evt) {
      evt.stopPropagation();
      var isOpen = profileMenu.classList.toggle("open");
      profileToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
    document.addEventListener("click", function (evt) {
      if (!profileMenu.contains(evt.target) && evt.target !== profileToggle) closeProfileMenu();
    });
    document.addEventListener("keydown", function (evt) {
      if (evt.key === "Escape") closeProfileMenu();
    });
  }

  /* ---------- validación en tiempo real: usuario / correo / contraseña ----------
     La "luz" de cada campo reutiliza los mismos colores de estado que ya
     usa el resto del tablero (--go/--redline, ver .chip--go/.chip--redline)
     en vez de una paleta de validación aparte — un semáforo más. Valida
     solo formato (las mismas reglas que ya aplica el servidor en
     adminPanel.ts) — no confirma disponibilidad real de username/correo,
     eso lo sigue resolviendo el submit. */
  var VALIDATORS = {
    username: function (v) {
      if (v === "") return { state: "empty", msg: "5 a 32 caracteres: minúsculas, números, punto, guion o guion bajo." };
      if (!/^[a-z0-9._-]{5,32}$/.test(v)) return { state: "bad", msg: "Solo minúsculas, números, punto, guion o guion bajo (5 a 32 caracteres)." };
      return { state: "ok", msg: "Formato correcto." };
    },
    email: function (v) {
      if (v === "") return { state: "empty", msg: "Necesitamos un correo para el login y las notificaciones." };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { state: "bad", msg: "Ese correo no tiene un formato válido." };
      return { state: "ok", msg: "Formato correcto." };
    },
    password: function (v) {
      if (v === "") return { state: "empty", msg: "Mínimo 8 caracteres." };
      if (v.length < 8) return { state: "bad", msg: "Todavía le faltan " + (8 - v.length) + " caracteres." };
      return { state: "ok", msg: "Contraseña válida." };
    },
  };
  document.querySelectorAll("[data-validate]").forEach(function (input) {
    var kind = input.getAttribute("data-validate");
    var validator = VALIDATORS[kind];
    if (!validator) return;
    var wrap = input.closest(".field");
    var light = wrap ? wrap.querySelector("[data-fieldcheck-light]") : null;
    var msg = wrap ? wrap.querySelector("[data-fieldcheck-msg]") : null;
    function setState(state, text) {
      if (light) {
        light.classList.remove("fieldcheck__light--ok", "fieldcheck__light--bad");
        if (state === "ok") light.classList.add("fieldcheck__light--ok");
        if (state === "bad") light.classList.add("fieldcheck__light--bad");
      }
      if (msg) {
        msg.textContent = text;
        msg.classList.remove("fieldcheck__msg--ok", "fieldcheck__msg--bad");
        if (state === "ok") msg.classList.add("fieldcheck__msg--ok");
        if (state === "bad") msg.classList.add("fieldcheck__msg--bad");
      }
    }
    function run() {
      var result = validator(input.value.trim());
      setState(result.state, result.msg);
      return result;
    }
    input.addEventListener("input", run);
    if (kind === "username") {
      // Al salir del campo (no en cada tecla) se consulta además si el
      // usuario ya está en uso (GET /admin/username-disponible) — solo
      // tiene sentido preguntarlo si el formato ya es válido. checkToken
      // descarta la respuesta si el campo ya cambió de nuevo mientras la
      // consulta estaba en vuelo (blur -> foco -> blur rápido).
      var checkToken = 0;
      input.addEventListener("blur", function () {
        var result = run();
        if (result.state !== "ok") return;
        var value = input.value.trim().toLowerCase();
        var myToken = ++checkToken;
        setState("empty", "Comprobando disponibilidad…");
        var excludeSelf = input.hasAttribute("data-exclude-self") ? "&excludeSelf=1" : "";
        fetch("/admin/username-disponible?username=" + encodeURIComponent(value) + excludeSelf)
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (myToken !== checkToken) return;
            if (data.taken) setState("bad", "Ese usuario ya está en uso.");
            else setState("ok", "Usuario disponible.");
          })
          .catch(function () {
            if (myToken !== checkToken) return;
            setState("empty", "No se pudo comprobar disponibilidad — se valida igual al guardar.");
          });
      });
    } else {
      input.addEventListener("blur", run);
    }
    run();
  });
})();
`;

/**
 * `GET /login` — formulario de login combinado (Fase 13 v2, ver ADR-032):
 * un solo campo `identifier` que matchea username o correo (ver
 * findAdminByUsernameOrEmail). Ruta bare, no anidada bajo `/admin`, para
 * poder servirla sin pasar por el hook de auth de ese prefijo. Reutiliza
 * `layout()` con `tenant: null` (shell bare) para no exponer el riel de
 * navegación a alguien todavía sin sesión. `GET /admin` ya no necesita una
 * página raíz separada — es directamente el resumen (renderOverviewPage),
 * protegido por el hook de auth de server.ts, que redirige acá si no hay
 * sesión.
 */
export async function renderLoginPage(error?: string): Promise<string | null> {
  const tenant = await getSettings();
  if (!tenant) {
    return null;
  }

  const errorBanner = error
    ? `<div class="banner banner--error">${escapeHtml(error)}</div>`
    : "";

  const body = `
    <div class="pagehead">
      <div class="loginmark" aria-hidden="true">${ICON_IGNITION}</div>
      <p class="eyebrow">${escapeHtml(brandName(tenant))}</p>
      <h1>Iniciar sesión</h1>
    </div>
    ${errorBanner}
    <div class="panel connection">
      <form method="POST" action="/login">
        <div class="field">
          <label for="identifier">Usuario o correo</label>
          <input type="text" id="identifier" name="identifier" required autofocus autocomplete="username">
        </div>
        <div class="field">
          <label for="password">Contraseña</label>
          <input type="password" id="password" name="password" required autocomplete="current-password">
        </div>
        <div class="formfoot"><button type="submit" class="btn btn--primary">${ICON_IGNITION}Entrar</button></div>
      </form>
    </div>
  `;
  return layout(`${brandName(tenant)} — Iniciar sesión`, null, body);
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
export async function renderOverviewPage(admin: AdminRecord): Promise<string | null> {
  const tenant = await getSettings();
  if (!tenant) {
    return null;
  }

  const { kpis, resuelto, actividad, recientes } = await withTransaction(async (client) => {
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
        <ul class="convlist">${conversacionesHtml || `<li>${emptyState(ICON_CONVERSACIONES, "Sin conversaciones todavía", "Acá aparecerán los últimos mensajes apenas un cliente le escriba al agente por WhatsApp.")}</li>`}</ul>
      </div>
    </section>
  `;

  return layout("Resumen", tenant, body, "resumen", admin);
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
  estadoParam: string | undefined,
  selectedId: string | undefined,
  admin: AdminRecord,
): Promise<string | null> {
  const tenant = await getSettings();
  if (!tenant) {
    return null;
  }
  const estado: ConversacionesEstado = CONVERSACIONES_TABS.some((t) => t.key === estadoParam)
    ? (estadoParam as ConversacionesEstado)
    : "todas";

  const { lista, detalle, mensajes } = await withTransaction(async (client) => {
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
      `<a class="tab${tab.key === estado ? " tab--active" : ""}" href="/admin/conversaciones?estado=${tab.key}">${escapeHtml(tab.label)}</a>`,
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
        <a class="convitem${row.id === selectedId ? " convitem--active" : ""}" href="/admin/conversaciones?estado=${estado}&c=${row.id}">
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
        <ul class="convitems">${listaHtml || `<li>${emptyState(ICON_CONVERSACIONES, "Nada en este filtro", "Probá con otra pestaña — Todas, Abiertas, Escaladas o Cerradas.")}</li>`}</ul>
      </aside>
      <section class="panel inbox__detail">${detalleHtml}</section>
    </div>
  `;

  return layout("Conversaciones", tenant, body, "conversaciones", admin);
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

async function fetchLeads(): Promise<LeadRow[]> {
  return withTransaction(async (client) => {
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
export async function renderLeadsPage(admin: AdminRecord): Promise<string | null> {
  const tenant = await getSettings();
  if (!tenant) {
    return null;
  }
  const rows = await fetchLeads();

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
        <a class="btn" href="/admin/leads.csv">Exportar CSV</a>
      </div>
    </div>
    <div class="panel tablewrap" data-table data-page-size="20">
      <div class="tabletools">
        <input type="search" class="searchbox" data-table-search placeholder="Buscar por cliente, mensaje o estado…" aria-label="Buscar leads">
      </div>
      <table data-resizable-table="leads">
        <colgroup>
          <col style="width:20%"><col style="width:44%"><col style="width:18%"><col style="width:18%">
        </colgroup>
        <thead><tr><th>Cliente</th><th>Último mensaje</th><th>Estado</th><th>Cliente desde</th></tr></thead>
        <tbody>${tableRows || `<tr><td colspan="4">${emptyState(ICON_LEADS, "Sin leads todavía", "Acá va a aparecer cada cliente que le escriba al agente, clasificado según su avance: cotización, escalada o pedido.")}</td></tr>`}</tbody>
      </table>
      <div class="pager">
        <span class="hint tabular"><span data-table-count>${rows.length}</span> de ${rows.length}</span>
        <div class="pager__controls" data-table-pager>
          <button type="button" data-table-prev aria-label="Página anterior">‹</button>
          <span class="tabular" data-table-pagelabel>1 / 1</span>
          <button type="button" data-table-next aria-label="Página siguiente">›</button>
        </div>
      </div>
    </div>
  `;

  return layout(`Leads (${rows.length})`, tenant, body, "leads", admin);
}

/** Mismo dato que renderLeadsPage, serializado a mano igual que el resto del panel arma HTML a mano (sin dependencia nueva). */
export async function exportLeadsCsv(): Promise<string | null> {
  const tenant = await getSettings();
  if (!tenant) {
    return null;
  }
  const rows = await fetchLeads();
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
export async function renderTicketsPage(admin: AdminRecord): Promise<string | null> {
  const tenant = await getSettings();
  if (!tenant) {
    return null;
  }

  const rows = await withTransaction(async (client) => {
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
        <td><a class="linklike" href="/admin/conversaciones?estado=escaladas&c=${row.conversation_id}">Ver conversación →</a></td>
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
      </div>
      <table data-resizable-table="tickets">
        <colgroup>
          <col style="width:15%"><col style="width:14%"><col style="width:10%">
          <col style="width:13%"><col style="width:11%"><col style="width:25%"><col style="width:12%">
        </colgroup>
        <thead><tr><th>Cliente</th><th>Motivo</th><th>Estado</th><th>Asignado a</th><th>Creado</th><th>Resumen</th><th></th></tr></thead>
        <tbody>${tableRows || `<tr><td colspan="7">${emptyState(ICON_TICKETS, "Sin tickets abiertos", "Acá van a aparecer los casos que el agente no pueda resolver solo — algo fuera de catálogo, un cliente molesto, algo que pida un humano.")}</td></tr>`}</tbody>
      </table>
      <div class="pager">
        <span class="hint tabular"><span data-table-count>${rows.length}</span> de ${rows.length}</span>
        <div class="pager__controls" data-table-pager>
          <button type="button" data-table-prev aria-label="Página anterior">‹</button>
          <span class="tabular" data-table-pagelabel>1 / 1</span>
          <button type="button" data-table-next aria-label="Página siguiente">›</button>
        </div>
      </div>
    </div>
  `;

  return layout(`Tickets (${rows.length})`, tenant, body, "tickets", admin);
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

interface CostoMesRow {
  tokens_entrada: string;
  tokens_salida: string;
  costo_usd: string;
}

interface TendenciaDiaRow {
  dia: string;
  costo_usd: string;
}

interface CostoPorResultadoRow {
  resultado: "con_pedido" | "sin_pedido";
  costo_promedio_usd: string | null;
  conversaciones: string;
}

interface SatisfaccionPromedioRow {
  promedio: string | null;
  total: string;
}

interface SatisfaccionDistribucionRow {
  satisfaction_score: number;
  cantidad: string;
}

interface ReviewRow {
  score: number | null;
  review_text: string;
  created_at: string;
  shared_publicly: boolean;
}

interface PagosEnLineaRow {
  pagados: string;
  monto_pagado_cop: string;
  pendientes: string;
}

/**
 * Analítica de costos (Fase 11.5, ver docs/fase-11-panel-admin-dashboard/
 * analitica-costos.md): fuente Postgres nativa (`llm_usage`, ADR-017), no
 * Grafana embebido ni Loki en vivo — evita acoplar la carga del panel a
 * una query de logs externa. `provider`/`model` de cada fila ya vienen
 * resueltos por `resolveLlmProviderForTenant` (ver src/orchestrator/loop.ts,
 * insert best-effort junto al log `orchestrator.llm_completado`).
 *
 * `cost_usd` en Postgres siempre queda en USD (es lo que factura cada
 * proveedor de LLM) — la moneda elegida es puramente de visualización, vía
 * `?moneda=`, no persistida por tenant. Si la tasa de cambio en vivo no está
 * disponible (ver src/shared/exchangeRates.ts), se degrada a USD en vez de
 * mostrar un número inventado.
 */
export async function renderAnaliticaPage(
  monedaParam: string | undefined,
  admin: AdminRecord,
): Promise<string | null> {
  const tenant = await getSettings();
  if (!tenant) {
    return null;
  }

  const monedaPedida: Currency = monedaParam && isCurrency(monedaParam) ? monedaParam : "USD";
  const rates = monedaPedida === "USD" ? null : await getUsdExchangeRates();
  const tasaNoDisponible = monedaPedida !== "USD" && rates === null;
  const moneda: Currency = tasaNoDisponible ? "USD" : monedaPedida;
  const toDisplay = (usd: number): number => convertFromUsd(usd, moneda, rates) ?? usd;

  const { costoMes, tendencia, costoPorResultado, satisfaccion, distribucion, reviews, pagosEnLinea } = await withTransaction(async (client) => {
    const costoMesResult = await client.query<CostoMesRow>(
      `SELECT
        coalesce(sum(input_tokens), 0) AS tokens_entrada,
        coalesce(sum(output_tokens), 0) AS tokens_salida,
        coalesce(sum(cost_usd), 0) AS costo_usd
       FROM llm_usage
       WHERE created_at >= date_trunc('month', now())`,
    );

    const tendenciaResult = await client.query<TendenciaDiaRow>(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS dia,
              coalesce(sum(cost_usd), 0) AS costo_usd
       FROM llm_usage
       WHERE created_at >= now() - interval '30 days'
       GROUP BY 1
       ORDER BY 1`,
    );

    // No reimplementa el funnel de metricas-cierre-ventas.md — solo agrega
    // el costo cruzado con su resultado (con/sin pedido), que ese
    // documento dejaba explícitamente pendiente por no existir el dato de
    // costo en Postgres todavía.
    // count(u.total_costo), no count(*): la LATERAL siempre devuelve una
    // fila por conversación cerrada aunque no tenga uso de LLM (sum da
    // NULL) — contar esas inflaría el número de conversaciones detrás del
    // promedio. count() ignora NULLs, igual que avg(), así que ambos
    // números describen exactamente el mismo conjunto de filas.
    const costoPorResultadoResult = await client.query<CostoPorResultadoRow>(
      `SELECT
        CASE WHEN o.id IS NOT NULL THEN 'con_pedido' ELSE 'sin_pedido' END AS resultado,
        round(avg(u.total_costo), 4) AS costo_promedio_usd,
        count(u.total_costo) AS conversaciones
       FROM conversations c
       LEFT JOIN orders o ON o.conversation_id = c.id
       JOIN LATERAL (
         SELECT sum(cost_usd) AS total_costo FROM llm_usage WHERE conversation_id = c.id
       ) u ON true
       WHERE c.status = 'closed'
       GROUP BY 1`,
    );

    // Satisfacción de clientes (extensión post-QA de Fase 12.2, ver
    // src/orchestrator/satisfactionSurvey.ts): el dato ya se guardaba
    // desde la encuesta, faltaba mostrarlo.
    const satisfaccionResult = await client.query<SatisfaccionPromedioRow>(
      `SELECT round(avg(satisfaction_score), 2) AS promedio, count(*) AS total
       FROM conversations WHERE satisfaction_score IS NOT NULL`,
    );
    const distribucionResult = await client.query<SatisfaccionDistribucionRow>(
      `SELECT satisfaction_score, count(*) AS cantidad
       FROM conversations WHERE satisfaction_score IS NOT NULL
       GROUP BY satisfaction_score`,
    );
    const reviewsResult = await client.query<ReviewRow>(
      `SELECT score, review_text, created_at, shared_publicly
       FROM reviews ORDER BY created_at DESC LIMIT 10`,
    );

    // Pagos en línea (Fase 12.4, ver ADR-024) — solo pedidos con
    // payment_method 'pago_en_linea': los otros 3 métodos nacen
    // 'pagado' por default (sin verificación digital, ver
    // migrations/0030_orders_payment_status.cjs) y no aportan nada útil acá.
    const pagosEnLineaResult = await client.query<PagosEnLineaRow>(
      `SELECT
        count(*) FILTER (WHERE payment_status = 'pagado') AS pagados,
        coalesce(sum(total) FILTER (WHERE payment_status = 'pagado'), 0) AS monto_pagado_cop,
        count(*) FILTER (WHERE payment_status = 'pendiente') AS pendientes
       FROM orders WHERE payment_method = 'pago_en_linea'`,
    );

    return {
      costoMes: costoMesResult.rows[0]!,
      tendencia: tendenciaResult.rows,
      costoPorResultado: costoPorResultadoResult.rows,
      satisfaccion: satisfaccionResult.rows[0]!,
      distribucion: distribucionResult.rows,
      reviews: reviewsResult.rows,
      pagosEnLinea: pagosEnLineaResult.rows[0]!,
    };
  });

  const tendenciaPorDia = new Map(tendencia.map((row) => [row.dia, Number(row.costo_usd)]));
  const dias = Array.from({ length: 30 }, (_, i) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - (29 - i));
    const iso = date.toISOString().slice(0, 10);
    const label = `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    // Convertir antes de redondear — redondear en USD y luego convertir
    // arrastraría el error de redondeo original a la moneda de destino.
    // Sin redondear a más de 6 decimales: a escala piloto el costo diario
    // real es fracciones de centavo (ver el mismo bug ya corregido acá
    // mismo) — redondear de más antes de graficar colapsaba días con costo
    // real a 0.
    return { label, valor: Math.round(toDisplay(tendenciaPorDia.get(iso) ?? 0) * 1e6) / 1e6 };
  });

  const filaConPedido = costoPorResultado.find((row) => row.resultado === "con_pedido");
  const filaSinPedido = costoPorResultado.find((row) => row.resultado === "sin_pedido");
  const costoConPedido = filaConPedido?.costo_promedio_usd;
  const costoSinPedido = filaSinPedido?.costo_promedio_usd;
  const totalTokensMes = Number(costoMes.tokens_entrada) + Number(costoMes.tokens_salida);
  const costoMesDisplay = toDisplay(Number(costoMes.costo_usd));
  // != null cubre null (fila existe, avg vacío) y undefined (sin fila) — en
  // ambos casos la UI debe mostrar "—", no "$0.00".
  const costoConPedidoDisplay = costoConPedido != null ? toDisplay(Number(costoConPedido)) : null;
  const costoSinPedidoDisplay = costoSinPedido != null ? toDisplay(Number(costoSinPedido)) : null;

  // "N conversaciones" en vez de una frase suelta ("conversaciones
  // cerradas") — mismo criterio que el hint "últimas N" de "Conversaciones
  // recientes" más arriba en el archivo: un hint corto tipo unidad, no una
  // oración a medias. Cuenta solo las conversaciones que aportaron al
  // promedio (con_pedido + sin_pedido), no el total de conversaciones
  // cerradas del tenant (esas dos cosas pueden diferir si alguna cerrada no
  // tiene ningún uso de LLM registrado).
  const totalConversacionesPromediadas = Number(filaConPedido?.conversaciones ?? 0) + Number(filaSinPedido?.conversaciones ?? 0);
  const pluralConversaciones = (n: number): string => (n === 1 ? "1 conversación cerrada" : `${n} conversaciones cerradas`);
  const currencyMeta = CURRENCY_META[moneda];

  const distribucionMap = new Map(distribucion.map((row) => [row.satisfaction_score, Number(row.cantidad)]));
  const totalCalificaciones = Number(satisfaccion.total);
  const promedioSatisfaccion = satisfaccion.promedio;
  const distribucionHtml = [5, 4, 3, 2, 1]
    .map(
      (n) =>
        `<div class="toolpill"><span>${"★".repeat(n)}</span><span class="toolpill__count tabular">${distribucionMap.get(n) ?? 0}</span></div>`,
    )
    .join("");
  const reviewsHtml = reviews.length
    ? reviews
        .map(
          (r) => `
        <div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border)">
          <p class="hint">${r.score ? "★".repeat(r.score) : "—"} · ${formatRelativo(r.created_at)}${r.shared_publicly ? ' · <span class="chip chip--go">Compartida</span>' : ""}</p>
          <p>"${escapeHtml(r.review_text)}"</p>
        </div>`,
        )
        .join("\n")
    : `<p class="hint">Todavía no hay reseñas.</p>`;

  const currencyOptionsHtml = SUPPORTED_CURRENCIES.map(
    (c) => `<option value="${c}"${c === moneda ? " selected" : ""}>${c}</option>`,
  ).join("");

  const body = `
    <div class="pagehead">
      <div class="pagehead__row">
        <div>
          <p class="eyebrow">Panel</p>
          <h1>Analítica</h1>
          <p>Costo y consumo de IA de ${escapeHtml(brandName(tenant))}, calculado desde el uso real por turno.</p>
        </div>
        <form method="get" class="currency-form" aria-label="Moneda para mostrar costos">
          <label for="moneda">Moneda</label>
          <select id="moneda" name="moneda" onchange="this.form.submit()">${currencyOptionsHtml}</select>
        </form>
      </div>
      ${tasaNoDisponible ? `<p>No se pudo obtener la tasa de cambio en vivo para ${escapeHtml(monedaPedida)} — mostrando USD.</p>` : ""}
    </div>

    <section class="kpirow" aria-label="Indicadores de costo">
      <article class="kpi">
        <p class="kpi__label">Costo · este mes</p>
        <div class="kpi__figure"><span class="kpi__number tabular">${escapeHtml(formatMoney(costoMesDisplay, moneda))}</span></div>
        <div class="kpi__foot"><span>${moneda}, desde el día 1</span></div>
      </article>
      <article class="kpi">
        <p class="kpi__label">Tokens · este mes</p>
        <div class="kpi__figure"><span class="kpi__number tabular" data-count-to="${totalTokensMes}">0</span></div>
        <div class="kpi__foot"><span>${Number(costoMes.tokens_entrada).toLocaleString("es-CO")} entrada · ${Number(costoMes.tokens_salida).toLocaleString("es-CO")} salida</span></div>
      </article>
      <article class="kpi">
        <p class="kpi__label">Costo promedio · conversación con pedido</p>
        <div class="kpi__figure"><span class="kpi__number tabular">${costoConPedidoDisplay !== null ? escapeHtml(formatMoney(costoConPedidoDisplay, moneda)) : "—"}</span></div>
        <div class="kpi__foot"><span>${filaConPedido ? pluralConversaciones(Number(filaConPedido.conversaciones)) : "Sin conversaciones cerradas con pedido"}</span></div>
      </article>
    </section>

    <section class="block" aria-label="Tendencia de costo">
      <div class="blockhead"><h2>Costo — últimos 30 días</h2><span class="hint">${moneda} / día</span></div>
      <div class="panel chartpanel">
        <div class="chart-wrap" id="chartWrap" data-format="money" data-symbol="${currencyMeta.symbol}" data-decimals="${currencyMeta.decimals}" data-money-suffix="${moneda === "USD" ? "" : ` ${moneda}`}" data-aria-label="Costo por dia, ultimos 30 dias, en ${moneda}"></div>
        <script type="application/json" id="actividad-data">${JSON.stringify(dias)}</script>
      </div>
    </section>

    <section class="block block--narrow" aria-label="Costo por resultado">
      <div class="blockhead"><h2>Costo promedio por resultado</h2><span class="hint">${totalConversacionesPromediadas} cerradas</span></div>
      <div class="panel connection">
        <div class="toolgrid">
          <div class="toolpill"><span>Con pedido</span><span class="toolpill__count tabular">${costoConPedidoDisplay !== null ? escapeHtml(formatMoney(costoConPedidoDisplay, moneda)) : "—"}</span></div>
          <div class="toolpill"><span>Sin pedido</span><span class="toolpill__count tabular">${costoSinPedidoDisplay !== null ? escapeHtml(formatMoney(costoSinPedidoDisplay, moneda)) : "—"}</span></div>
        </div>
      </div>
    </section>

    <section class="block block--narrow" aria-label="Satisfacción de clientes">
      <div class="blockhead"><h2>Satisfacción de clientes</h2><span class="hint">${totalCalificaciones} calificaciones</span></div>
      <div class="panel connection">
        <div class="connection__head">
          <h2>${promedioSatisfaccion ?? "—"}${promedioSatisfaccion ? " / 5" : ""}</h2>
        </div>
        <div class="toolgrid">${distribucionHtml}</div>
      </div>
    </section>

    <section class="block block--narrow" aria-label="Reseñas recientes">
      <div class="blockhead"><h2>Reseñas recientes</h2></div>
      <div class="panel connection">
        ${reviewsHtml}
      </div>
    </section>

    <section class="block block--narrow" aria-label="Pagos en línea">
      <div class="blockhead"><h2>Pagos en línea</h2><span class="hint">Wompi</span></div>
      <div class="panel connection">
        <div class="toolgrid">
          <div class="toolpill"><span>Confirmados</span><span class="toolpill__count tabular">${pagosEnLinea.pagados}</span></div>
          <div class="toolpill"><span>Monto confirmado</span><span class="toolpill__count tabular">$${Number(pagosEnLinea.monto_pagado_cop).toLocaleString("es-CO")}</span></div>
          <div class="toolpill"><span>Pendientes de pago</span><span class="toolpill__count tabular">${pagosEnLinea.pendientes}</span></div>
        </div>
      </div>
    </section>
  `;

  return layout("Analítica", tenant, body, "analitica", admin);
}

/**
 * Flujo del agente (Fase 11.3, ver docs/fase-11-panel-admin-dashboard/
 * flujo-conexiones.md): diagrama estático con los nodos reales del
 * orquestador — no editable, mismo criterio que el panel de referencia
 * ("radiografía honesta, no un editor"). Los contadores por tool se
 * derivan de messages.tool_calls, sin tabla nueva.
 */
export async function renderFlujoPage(admin: AdminRecord): Promise<string | null> {
  const tenant = await getSettings();
  if (!tenant) {
    return null;
  }

  const counts = await withTransaction(async (client) => {
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

  // Ya no asume el default de plataforma (env.LLM_PROVIDER/LLM_MODEL) — un
  // tenant puede tener su propio override desde la Fase 11.4 (ver
  // Configuración), así que se resuelve igual que resolveLlmProviderForTenant
  // (sin instanciar el provider ni gastar la llamada real al LLM, esto es
  // solo texto informativo).
  const llmConfigFlujo = await getLlmConfig();
  const flujoProviderKey =
    llmConfigFlujo.provider && isProviderKey(llmConfigFlujo.provider) ? llmConfigFlujo.provider : null;
  const modelo = flujoProviderKey
    ? `${PROVIDER_CATALOG[flujoProviderKey].label} · ${escapeHtml(llmConfigFlujo.model ?? PROVIDER_CATALOG[flujoProviderKey].defaultModel)}`
    : `${env.llmProvider === "anthropic" ? "Claude (Anthropic)" : "DeepSeek"} · ${escapeHtml(env.llmProvider === "anthropic" ? "claude-sonnet-5" : env.llmModel)} (default de plataforma)`;

  const body = `
    <div class="pagehead">
      <p class="eyebrow">Agente</p>
      <h1>Flujo</h1>
      <p>Cómo procesa el agente un mensaje de ${escapeHtml(brandName(tenant))}, con los nodos reales del orquestador.</p>
    </div>
    <div class="flow">
      <div class="flownode">
        <span class="flownode__eyebrow">Canal</span>
        <span class="flownode__title"><span class="flownode__badge">${ICON_WHATSAPP}</span>WhatsApp · Twilio</span>
      </div>
      <div class="flowline"></div>
      <div class="flownode flownode--core">
        <span class="flownode__eyebrow">Orquestador</span>
        <span class="flownode__title mono"><span class="flownode__badge">${ICON_ORQUESTADOR}</span>src/orchestrator/loop.ts</span>
        <div class="flowsub">
          <div class="flowsatellites">
            <div class="flowsat"><span class="flowsat__label">Modelo</span><span class="flowsat__value mono">${modelo}</span></div>
            <div class="flowsat"><span class="flowsat__label">Memoria</span><span class="flowsat__value">Estado de la conversación + historial completo de mensajes</span></div>
          </div>
          <div class="flowtools">
            <span class="flowtools__label">${ICON_TOOL}Tools</span>
            <div class="toolgrid">${toolPills}</div>
          </div>
        </div>
      </div>
      <div class="flowline"></div>
      <div class="flownode">
        <span class="flownode__eyebrow">Respuesta</span>
        <span class="flownode__title"><span class="flownode__badge">${ICON_RESPUESTA}</span>Outbound vía Twilio</span>
      </div>
    </div>
    <p class="flowfoot">Llamadas por tool en los últimos 30 días.</p>
  `;

  return layout("Flujo del agente", tenant, body, "flujo", admin);
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
export async function renderConexionesPage(admin: AdminRecord): Promise<string | null> {
  const tenant = await getSettings();
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
      <p>${conectado ? "1 de 1" : "0 de 1"} canal conectado — WhatsApp por Twilio es el único canal que integra ${escapeHtml(brandName(tenant))} hoy.</p>
    </div>
    <div class="panel connection${conectado ? " connection--live" : ""}">
      <div class="connection__head">
        <div class="connection__titlewrap">
          <span class="connection__icon">${ICON_WHATSAPP}</span>
          <h2>WhatsApp · Twilio</h2>
        </div>
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

  return layout("Conexiones", tenant, body, "conexiones", admin);
}

/** Una fila de variante dentro del modal de alta/edición de producto — `variant: null` es una fila en blanco (nueva, del `<template>`); con datos es una variante ya persistida (edición). */
function variantRowHtml(
  variant: { id: string; sku: string; attributes: Record<string, unknown>; price: number; stock: number; active: boolean } | null,
  removable: boolean,
): string {
  const talla = variant && typeof variant.attributes.talla === "string" ? variant.attributes.talla : "";
  const color = variant && typeof variant.attributes.color === "string" ? variant.attributes.color : "";
  const active = variant ? variant.active : true;
  const removeBtn = removable
    ? `<button type="button" class="btn btn--ghost btn--sm" data-remove-variant-row>Quitar</button>`
    : "";
  return `<div class="variantrow" data-variant-row>
    <input type="hidden" name="variantId[]" value="${variant ? escapeHtml(variant.id) : ""}">
    <input type="text" name="sku[]" value="${variant ? escapeHtml(variant.sku) : ""}" placeholder="SKU" required>
    <input type="text" name="talla[]" value="${escapeHtml(talla)}" placeholder="Talla (opcional)">
    <input type="text" name="color[]" value="${escapeHtml(color)}" placeholder="Color (opcional)">
    <input type="number" name="price[]" value="${variant ? variant.price : ""}" placeholder="Precio" min="0" step="1" required>
    <input type="number" name="stock[]" value="${variant ? variant.stock : "0"}" placeholder="Stock" min="0" step="1" required>
    <label class="variantrow__active"><input type="checkbox" data-active-toggle${active ? " checked" : ""}><input type="hidden" name="active[]" value="${active ? "true" : "false"}">Activa</label>
    ${removeBtn}
  </div>`;
}

/**
 * Modal de alta o edición de producto — un mismo template para ambos casos
 * (`product: null` = alta, con datos = edición). Trae nombre/descripción/
 * imagen/aliado/categoría y la lista dinámica de variantes (Agregar/Quitar
 * en `CLIENT_SCRIPT`, sin librería). El submit va siempre a
 * `POST /admin/productos/:id` (edición) o `POST /admin/productos` (alta) —
 * ver `crearProducto`/`guardarProducto`.
 */
function productoDialogHtml(
  dialogId: string,
  title: string,
  product: ProductDetail | null,
  allies: AllyRecord[],
  categories: CategoryRecord[],
): string {
  const action = product ? `/admin/productos/${product.id}` : "/admin/productos";
  const variantRows = product
    ? product.variants.map((v) => variantRowHtml(v, false)).join("")
    : variantRowHtml(null, false);

  return `<dialog id="${dialogId}" class="modal modal--wide">
    <div class="blockhead"><h2>${escapeHtml(title)}</h2></div>
    <form method="POST" action="${action}">
      <div class="field">
        <label for="${dialogId}-nombre">Nombre</label>
        <input type="text" id="${dialogId}-nombre" name="name" required value="${product ? escapeHtml(product.name) : ""}">
      </div>
      <div class="field">
        <label for="${dialogId}-descripcion">Descripción</label>
        <input type="text" id="${dialogId}-descripcion" name="description" value="${escapeHtml(product?.description ?? "")}">
      </div>
      <div class="field">
        <label for="${dialogId}-imagen">Imagen (URL)</label>
        <input type="text" id="${dialogId}-imagen" name="imageUrl" placeholder="https://…" value="${escapeHtml(product?.imageUrl ?? "")}">
      </div>
      <div class="field">
        <label for="${dialogId}-aliado">Aliado</label>
        <select id="${dialogId}-aliado" name="allyId">${allyOptionsHtml(allies, product?.allyId ?? allies[0]?.id ?? "")}</select>
      </div>
      <div class="field">
        <label for="${dialogId}-categoria">Categoría</label>
        <select id="${dialogId}-categoria" name="categoryId">${categoryOptionsHtml(categories, product?.categoryId ?? null)}</select>
      </div>
      <div class="field">
        <label>Variantes</label>
        <p class="hint">Dejá talla/color vacíos si el producto no tiene variantes reales — igual necesita al menos una fila (SKU/precio/stock).</p>
        <div class="variantlist" data-variant-list>${variantRows}</div>
        <template data-variant-row-template>${variantRowHtml(null, true)}</template>
        <button type="button" class="btn btn--ghost btn--sm" data-add-variant-row>+ Agregar variante</button>
      </div>
      <div class="formfoot">
        <button type="submit" class="btn btn--primary">${product ? "Guardar cambios" : "Crear producto"}</button>
        <button type="button" data-close-dialog="${dialogId}" class="btn btn--ghost">Cancelar</button>
      </div>
    </form>
  </dialog>`;
}

function allyFilterOptionsHtml(allies: AllyRecord[]): string {
  return (
    `<option value="">Todos los aliados</option>` +
    allies.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("")
  );
}

function categoryFilterOptionsHtml(categories: CategoryRecord[]): string {
  const blank = `<option value="">Todas las categorías</option>`;
  const options = categoryTreeOrder(categories)
    .map((c) => `<option value="${c.id}">${"— ".repeat(c.depth)}${escapeHtml(c.name)}</option>`)
    .join("");
  return blank + options;
}

/** Chip de solo lectura para un atributo de variante (ej. "Talla: M") — se omite si la variante no tiene ese atributo (productos genéricos). */
function attributeTag(label: string, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    return "";
  }
  return `<span class="tag">${escapeHtml(label)}: ${escapeHtml(value)}</span>`;
}

/** Switch compacto de Activar/Desactivar (Aliados/Categorías) — reemplaza el botón de texto condicional, mismo verde/rojo pero sin competir en ancho con Guardar/Editar. `actionUrlBase` es la URL sin el segmento final ("activar"/"desactivar"), ej. "/admin/aliados/{id}". */
function toggleSwitchHtml(actionUrlBase: string, active: boolean, subjectLabel: string): string {
  const nextAction = active ? "desactivar" : "activar";
  // El switch reemplazó un botón de texto explícito ("Desactivar") por un
  // control mucho más chico y fácil de tocar sin querer — `data-confirm`
  // recupera esa fricción intencional antes de un cambio de estado real,
  // mostrando la modal compartida #confirm-dialog (ver layout()/
  // CLIENT_SCRIPT) en vez de un window.confirm() nativo fuera de estilo.
  const confirmMsg =
    nextAction === "desactivar"
      ? `¿Desactivar ${subjectLabel}? Deja de estar disponible para el asistente.`
      : `¿Activar ${subjectLabel} de nuevo?`;
  return `<form method="POST" action="${actionUrlBase}/${nextAction}" data-confirm="${escapeHtml(confirmMsg)}">
    <button type="submit" class="toggleswitch${active ? " toggleswitch--on" : ""}" aria-label="${nextAction === "activar" ? "Activar" : "Desactivar"}" title="${nextAction === "activar" ? "Activar" : "Desactivar"}">
      <span class="toggleswitch__track"><span class="toggleswitch__knob"></span></span>
    </button>
  </form>`;
}

/** Columna Estado (Aliados/Categorías) — el switch de Activar/Desactivar vive acá directo, con su propio texto de estado al lado, en vez de un chip de solo lectura separado de la acción que lo cambia. */
function statusToggleHtml(
  actionUrlBase: string,
  active: boolean,
  subjectLabel: string,
  activeLabel: string,
  inactiveLabel: string,
): string {
  return `<div class="statustoggle">
    ${toggleSwitchHtml(actionUrlBase, active, subjectLabel)}
    <span class="statustoggle__label${active ? "" : " statustoggle__label--off"}">${active ? activeLabel : inactiveLabel}</span>
  </div>`;
}

export async function renderProductosPage(
  admin: AdminRecord,
  query: {
    error?: string;
    guardado?: string;
    allyId?: string;
    categoryId?: string;
    creados?: string;
    actualizados?: string;
    errores?: string;
  },
): Promise<string | null> {
  const tenant = await getSettings();
  if (!tenant) {
    return null;
  }

  const [products, allies, categories] = await Promise.all([
    listProductsSummary({ allyId: query.allyId, categoryId: query.categoryId }),
    listAllies(),
    listCategories(),
  ]);
  const productDetails = await Promise.all(products.map((p) => getProductDetail(p.id)));

  const banner = query.error
    ? `<div class="banner banner--error">${escapeHtml(query.error)}</div>`
    : query.guardado
      ? `<div class="banner banner--ok">Cambios guardados.</div>`
      : query.creados !== undefined
        ? `<div class="banner ${query.errores && query.errores !== "0" ? "banner--error" : "banner--ok"}">
             Carga por CSV — creados: ${escapeHtml(query.creados)} · actualizados: ${escapeHtml(query.actualizados ?? "0")} · con error: ${escapeHtml(query.errores ?? "0")}
             ${query.errores && query.errores !== "0" ? " — revisá que cada fila tenga sku/name/price/stock válidos; las filas con error no se cargaron." : ""}
           </div>`
        : "";

  const filterNotice =
    query.allyId || query.categoryId
      ? (() => {
          const parts: string[] = [];
          if (query.allyId) {
            const ally = allies.find((a) => a.id === query.allyId);
            parts.push(`aliado <strong>${escapeHtml(ally?.name ?? "desconocido")}</strong>`);
          }
          if (query.categoryId) {
            const category = categories.find((c) => c.id === query.categoryId);
            parts.push(`categoría <strong>${escapeHtml(category?.name ?? "desconocida")}</strong>`);
          }
          return `<p class="hint">Filtrado por ${parts.join(" y ")} — <a href="/admin/productos">ver todos</a>.</p>`;
        })()
      : "";

  const tableRows = products
    .map((product, index) => {
      const detail = productDetails[index] ?? null;
      const img = product.imageUrl
        ? `<img class="thumb" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}">`
        : "";
      const search = [product.name, product.categoryName, product.allyName, product.description]
        .filter((v): v is string => Boolean(v))
        .join(" ")
        .toLowerCase();
      const rapidoFormId = `rapido-${product.id}`;
      const editarDialogId = `editar-producto-${product.id}`;
      const expandId = `variantes-${product.id}`;
      const priceRange =
        product.minPrice === product.maxPrice
          ? formatCOP(product.minPrice)
          : `${formatCOP(product.minPrice)} – ${formatCOP(product.maxPrice)}`;

      const variantChips = (detail?.variants ?? [])
        .map(
          (v) => `<div class="variantchip${v.active ? "" : " variantchip--inactive"}">
            <span class="variantchip__sku mono">${escapeHtml(v.sku)}</span>
            <span class="variantchip__attrs">${attributeTag("Talla", v.attributes.talla)}${attributeTag("Color", v.attributes.color)}${!v.active ? '<span class="tag">Inactiva</span>' : ""}</span>
            <span class="variantchip__price">${formatCOP(v.price)}</span>
            <span class="variantchip__stock ${v.stock === 0 ? "stock-cero" : ""}">stock ${v.stock}</span>
          </div>`,
        )
        .join("");

      return `<tr data-search="${escapeHtml(search)}" data-filter-ally="${product.allyId}" data-filter-category="${product.categoryId ?? ""}" data-filter-stock="${product.totalStock > 0 ? "con" : "sin"}" data-expand-target="${expandId}" data-sort-name="${escapeHtml(product.name.toLowerCase())}" data-sort-variants="${product.variantCount}" data-sort-price="${product.minPrice}" data-sort-stock="${product.totalStock}" data-sort-description="${escapeHtml((product.description ?? "").toLowerCase())}">
        <td>${img}</td>
        <td class="dblclick-cell">
          <form id="${rapidoFormId}" method="POST" action="/admin/productos/${product.id}">
            <input type="hidden" name="imageUrl" value="${escapeHtml(product.imageUrl ?? "")}">
            <input type="hidden" name="allyId" value="${product.allyId}">
            <input type="hidden" name="categoryId" value="${product.categoryId ?? ""}">
            <input type="text" name="name" value="${escapeHtml(product.name)}" required>
          </form>
          <p class="rowmeta">${escapeHtml(product.allyName)}${product.categoryName ? ` · ${escapeHtml(product.categoryName)}` : ""}</p>
        </td>
        <td>
          <button type="button" class="expandtoggle" data-expand-toggle="${expandId}" aria-expanded="false" aria-label="Ver variantes">${ICON_CHEVRON}</button>
          ${product.variantCount} ${product.variantCount === 1 ? "variante" : "variantes"}
        </td>
        <td class="mono">${priceRange}</td>
        <td class="mono ${product.totalStock === 0 ? "stock-cero" : ""}">${product.totalStock}</td>
        <td class="dblclick-cell"><input type="text" name="description" form="${rapidoFormId}" value="${escapeHtml(product.description ?? "")}"></td>
        <td><div class="rowactions">
          <button type="submit" form="${rapidoFormId}" class="btn btn--ghost btn--icon" aria-label="Guardar cambios" title="Guardar cambios">${ICON_SAVE}</button>
          <button type="button" data-open-dialog="${editarDialogId}" class="btn btn--ghost btn--icon" aria-label="Editar producto" title="Editar producto">${ICON_EDIT}</button>
        </div></td>
      </tr>
      <tr class="expandrow" id="${expandId}"><td colspan="7"><div class="variantgrid">${variantChips}</div></td></tr>
      ${productoDialogHtml(editarDialogId, `Editar ${product.name}`, detail, allies, categories)}`;
    })
    .join("\n");

  const body = `
    <div class="pagehead">
      <p class="eyebrow">Catálogo</p>
      <h1>Productos</h1>
      <p>${products.length} productos en el catálogo de ${escapeHtml(brandName(tenant))}.</p>
      ${filterNotice}
    </div>
    ${banner}
    <div class="panel tablewrap" data-table data-page-size="20">
      <div class="tabletools">
        <input type="search" class="searchbox" data-table-search placeholder="Buscar por nombre, categoría o descripción…" aria-label="Buscar productos">
        <select class="tablefilter" data-table-filter data-filter-key="ally" aria-label="Filtrar por aliado">${allyFilterOptionsHtml(allies)}</select>
        <select class="tablefilter" data-table-filter data-filter-key="category" aria-label="Filtrar por categoría">${categoryFilterOptionsHtml(categories)}</select>
        <select class="tablefilter" data-table-filter data-filter-key="stock" aria-label="Filtrar por stock">
          <option value="">Con o sin stock</option>
          <option value="con">Con stock</option>
          <option value="sin">Sin stock</option>
        </select>
        <div class="tabletools__actions">
          <button type="button" data-open-dialog="importar-csv-dialog" class="btn btn--add" aria-label="Importar productos por CSV">${ICON_IMPORT} Importar CSV</button>
          <button type="button" data-open-dialog="nuevo-producto-dialog" class="btn btn--add" aria-label="Agregar producto"><span class="btn--add__plus">+</span> Nuevo producto</button>
        </div>
      </div>
      <table data-resizable-table="productos">
        <colgroup>
          <col style="width:7%"><col style="width:24%"><col style="width:13%">
          <col style="width:12%"><col style="width:9%"><col style="width:27%"><col style="width:8%">
        </colgroup>
        <thead><tr>
          <th>Foto</th>
          <th class="sortable" data-sort-key="name">Producto</th>
          <th class="sortable" data-sort-key="variants">Variantes</th>
          <th class="sortable" data-sort-key="price">Precio</th>
          <th class="sortable" data-sort-key="stock">Stock</th>
          <th class="sortable" data-sort-key="description">Descripción</th>
          <th>Acciones</th>
        </tr></thead>
        <tbody>${tableRows || `<tr><td colspan="7">${emptyState(ICON_PRODUCTOS, "Sin productos en el catálogo", "Creá el primero con el botón de arriba.")}</td></tr>`}</tbody>
      </table>
      <div class="pager">
        <span class="hint tabular"><span data-table-count>${products.length}</span> de ${products.length}</span>
        <div class="pager__controls" data-table-pager>
          <button type="button" data-table-prev aria-label="Página anterior">‹</button>
          <span class="tabular" data-table-pagelabel>1 / 1</span>
          <button type="button" data-table-next aria-label="Página siguiente">›</button>
        </div>
      </div>
    </div>
    ${productoDialogHtml("nuevo-producto-dialog", "Nuevo producto", null, allies, categories)}
    ${importarCsvDialogHtml(allies)}
    ${importarCsvPreviewDialogHtml(categories)}
  `;

  return layout(`Catálogo (${products.length} productos)`, tenant, body, "productos", admin);
}

/** Paso 1 de la carga por CSV: elegir aliado + archivo. El botón dispara `previsualizarImportacionCsv` por `fetch()` (ver CLIENT_SCRIPT) y, si todo sale bien, abre `importarCsvPreviewDialogHtml` con el resultado — no navega a ninguna página nueva. */
function importarCsvDialogHtml(allies: AllyRecord[]): string {
  return `<dialog id="importar-csv-dialog" class="modal">
    <div class="blockhead"><h2>Importar productos por CSV</h2></div>
    <p class="hint">Carga masiva en nombre de un aliado — vas a poder revisar y editar cada fila antes de confirmar la carga.</p>
    <div class="field">
      <label for="importar-aliado">Aliado</label>
      <select id="importar-aliado" data-import-ally-select>${allyOptionsHtml(allies, allies[0]?.id ?? "")}</select>
      <p class="hint">Los SKU nuevos del archivo se crean bajo este aliado. Los SKU que ya existen no cambian de aliado — solo se actualiza su precio y stock.</p>
    </div>
    <div class="field">
      <label for="importar-archivo">Archivo CSV</label>
      <input type="file" id="importar-archivo" accept=".csv,text/csv" data-csv-input>
      <input type="hidden" data-csv-hidden>
      <p class="hint">Columnas: <code>sku,name,price,stock</code> obligatorias — <code>talla,color,description,imageUrl</code> opcionales. La primera fila debe ser el encabezado. Varias filas nuevas con el mismo <code>name</code> se agrupan como variantes de un mismo producto. La categoría de cada producto nuevo se elige en la previsualización.</p>
    </div>
    <p class="hint" data-import-step1-error></p>
    <div class="formfoot">
      <button type="button" class="btn btn--primary" data-import-preview-btn>Previsualizar</button>
      <button type="button" data-close-dialog="importar-csv-dialog" class="btn btn--ghost">Cancelar</button>
    </div>
  </dialog>`;
}

/**
 * Paso 2: previsualización editable, llenada por JS (`renderImportPreview`
 * en CLIENT_SCRIPT) a partir del JSON que devuelve `previsualizarImportacionCsv`.
 * El árbol de categorías viaja embebido como JSON (mismo dato que arma
 * `categoryOptionsHtml` para el modal de producto) para que el JS pueda
 * armar un `<select>` de categoría por cada producto nuevo sin otro
 * round-trip — el CSV no trae categoría, se elige acá antes de confirmar
 * (ver README de Fase 14, "la carga masiva nunca reasigna categoría de un
 * producto existente" sigue aplicando para las filas de actualización).
 * "Confirmar carga" es un submit real (no fetch) para poder mostrar el
 * resumen final con el mismo patrón de banner que el resto del panel.
 */
function importarCsvPreviewDialogHtml(categories: CategoryRecord[]): string {
  const categoryTree = categoryTreeOrder(categories);
  return `<dialog id="importar-csv-preview-dialog" class="modal modal--xwide">
    <div class="blockhead"><h2>Confirmar carga</h2></div>
    <p class="hint" data-import-summary></p>
    <script type="application/json" data-import-categories>${JSON.stringify(categoryTree).replace(/</g, "\\u003c")}</script>
    <form method="POST" action="/admin/productos/importar">
      <input type="hidden" name="allyId" data-import-ally-hidden>
      <div class="importpreview" data-import-preview-body></div>
      <div class="formfoot">
        <button type="submit" class="btn btn--primary">Confirmar carga</button>
        <button type="button" data-close-dialog="importar-csv-preview-dialog" class="btn btn--ghost">Cancelar</button>
      </div>
    </form>
  </dialog>`;
}

function parseVariantInputs(body: Record<string, string | string[] | undefined>): {
  variantId: string;
  sku: string;
  price: string;
  stock: string;
  talla: string;
  color: string;
  active: string;
}[] {
  const toArray = (value: string | string[] | undefined): string[] =>
    value === undefined ? [] : Array.isArray(value) ? value : [value];
  const skus = toArray(body["sku[]"]);
  const variantIds = toArray(body["variantId[]"]);
  const prices = toArray(body["price[]"]);
  const stocks = toArray(body["stock[]"]);
  const tallas = toArray(body["talla[]"]);
  const colors = toArray(body["color[]"]);
  const actives = toArray(body["active[]"]);

  return skus.map((sku, i) => ({
    variantId: variantIds[i] ?? "",
    sku,
    price: prices[i] ?? "",
    stock: stocks[i] ?? "",
    talla: tallas[i] ?? "",
    color: colors[i] ?? "",
    active: actives[i] ?? "true",
  }));
}

function buildVariantAttributes(talla: string, color: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (talla.trim() !== "") {
    attributes.talla = talla.trim();
  }
  if (color.trim() !== "") {
    attributes.color = color.trim();
  }
  return attributes;
}

/** Mensaje específico si el SKU ya está en uso (`product_variants_sku_key`) — genérico para cualquier otro error de base. */
function productUniqueViolationMessage(error: unknown): string {
  const pgError = error instanceof Error ? (error as { code?: string; constraint?: string }) : undefined;
  if (pgError?.code === "23505" && pgError.constraint === "product_variants_sku_key") {
    return "Ya existe una variante con ese SKU — usá uno distinto.";
  }
  return "No se pudo guardar el producto.";
}

export async function crearProducto(input: {
  name: string;
  description: string;
  imageUrl: string;
  allyId: string;
  categoryId: string;
  variants: Record<string, string | string[] | undefined>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) {
    return { ok: false, error: "El nombre del producto es obligatorio." };
  }
  if (!input.allyId) {
    return { ok: false, error: "Elegí un aliado." };
  }

  const parsedVariants = parseVariantInputs(input.variants);
  if (parsedVariants.length === 0) {
    return { ok: false, error: "El producto necesita al menos una variante (SKU, precio y stock)." };
  }

  const variants: VariantInput[] = [];
  for (const v of parsedVariants) {
    if (!v.sku.trim()) {
      return { ok: false, error: "Cada variante necesita un SKU." };
    }
    const price = Number.parseFloat(v.price);
    const stock = Number.parseInt(v.stock, 10);
    if (!Number.isFinite(price) || price < 0) {
      return { ok: false, error: `Precio inválido para el SKU ${v.sku}.` };
    }
    if (!Number.isInteger(stock) || stock < 0) {
      return { ok: false, error: `Stock inválido para el SKU ${v.sku}.` };
    }
    variants.push({ sku: v.sku.trim(), attributes: buildVariantAttributes(v.talla, v.color), price, stock });
  }

  try {
    await createProduct({
      name,
      description: input.description.trim() || null,
      imageUrl: input.imageUrl.trim() || null,
      allyId: input.allyId,
      categoryId: input.categoryId === "" ? null : input.categoryId,
      variants,
    });
  } catch (error) {
    return { ok: false, error: productUniqueViolationMessage(error) };
  }
  return { ok: true };
}

/**
 * Guarda un producto existente — usado tanto por la edición rápida por
 * doble clic (nombre/aliado/categoría/descripción, sin variantes en el
 * form) como por el modal completo (todos los campos + variantes). A
 * diferencia de `crearProducto`, acá **no** se exige al menos una
 * variante: un array vacío significa "esta vez no se tocan variantes",
 * nunca "borrar todas" (las variantes solo se desactivan explícitamente
 * desde el modal, nunca se eliminan).
 */
export async function guardarProducto(
  productId: string,
  input: {
    name: string;
    description: string;
    imageUrl: string;
    allyId: string;
    categoryId: string;
    variants: Record<string, string | string[] | undefined>;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) {
    return { ok: false, error: "El nombre del producto es obligatorio." };
  }
  if (!input.allyId) {
    return { ok: false, error: "Elegí un aliado." };
  }

  const parsedVariants = parseVariantInputs(input.variants);
  const variants: VariantUpdateInput[] = [];
  for (const v of parsedVariants) {
    if (!v.sku.trim()) {
      return { ok: false, error: "Cada variante necesita un SKU." };
    }
    const price = Number.parseFloat(v.price);
    const stock = Number.parseInt(v.stock, 10);
    if (!Number.isFinite(price) || price < 0) {
      return { ok: false, error: `Precio inválido para el SKU ${v.sku}.` };
    }
    if (!Number.isInteger(stock) || stock < 0) {
      return { ok: false, error: `Stock inválido para el SKU ${v.sku}.` };
    }
    variants.push({
      id: v.variantId === "" ? null : v.variantId,
      sku: v.sku.trim(),
      attributes: buildVariantAttributes(v.talla, v.color),
      price,
      stock,
      active: v.active === "true",
    });
  }

  try {
    await updateProduct(productId, {
      name,
      description: input.description.trim() || null,
      imageUrl: input.imageUrl.trim() || null,
      allyId: input.allyId,
      categoryId: input.categoryId === "" ? null : input.categoryId,
      variants,
    });
  } catch (error) {
    return { ok: false, error: productUniqueViolationMessage(error) };
  }
  return { ok: true };
}

export interface CsvPreviewRow {
  rowNumber: number;
  sku: string;
  name: string;
  price: string;
  stock: string;
  talla: string;
  color: string;
  description: string;
  imageUrl: string;
  kind: "crear" | "actualizar" | "error";
  errorMessage?: string;
  existingPrice?: number;
  existingStock?: number;
  existingDescription?: string | null;
  existingImageUrl?: string | null;
}

/**
 * Previsualización de la carga masiva de CSV (extensión post-Fase 14, ver
 * docs/fase-14-catalogo-extendido/README.md#extensión-post-fase) — clasifica
 * cada fila del archivo (crear / actualizar / error) sin escribir nada
 * todavía, para que el admin revise y edite antes de confirmar la carga
 * (`confirmarImportacionCsv`). El archivo se lee client-side con FileReader
 * (mismo patrón que el avatar del Perfil) y viaja como texto plano por
 * `fetch()` — evita agregar `@fastify/multipart` al proyecto.
 */
export async function previsualizarImportacionCsv(
  csvText: string,
): Promise<{ ok: true; rows: CsvPreviewRow[] } | { ok: false; error: string }> {
  const parsed = parseCsv(csvText);
  if (parsed.rows.length === 0) {
    return { ok: false, error: "El archivo no tiene filas para importar." };
  }

  const skus = parsed.rows.map((row) => (row.sku ?? "").trim()).filter((sku) => sku !== "");
  const existingBySku = await classifySkus(skus);

  const rows: CsvPreviewRow[] = parsed.rows.map((row, i) => {
    const rowNumber = i + 2; // +1 por el encabezado, +1 por índice base 1
    const sku = (row.sku ?? "").trim();
    if (!sku) {
      return {
        rowNumber,
        sku: "",
        name: "",
        price: "",
        stock: "",
        talla: "",
        color: "",
        description: "",
        imageUrl: "",
        kind: "error",
        errorMessage: "Falta el SKU.",
      };
    }

    const existing = existingBySku.get(sku);
    if (existing) {
      return {
        rowNumber,
        sku,
        name: existing.productName,
        price: (row.price ?? "").trim() || String(existing.price),
        stock: (row.stock ?? "").trim() || String(existing.stock),
        talla: "",
        color: "",
        description: "",
        imageUrl: "",
        kind: "actualizar",
        existingPrice: existing.price,
        existingStock: existing.stock,
        existingDescription: existing.description,
        existingImageUrl: existing.imageUrl,
      };
    }

    const name = (row.name ?? "").trim();
    return {
      rowNumber,
      sku,
      name,
      price: (row.price ?? "").trim(),
      stock: (row.stock ?? "").trim(),
      talla: (row.talla ?? "").trim(),
      color: (row.color ?? "").trim(),
      description: (row.description ?? "").trim(),
      imageUrl: (row.imageUrl ?? "").trim(),
      kind: name ? "crear" : "error",
      errorMessage: name ? undefined : "Falta el nombre para el SKU nuevo.",
    };
  });

  return { ok: true, rows };
}

/**
 * Actualiza solo precio/stock si el SKU ya existe (nunca reasigna
 * aliado/categoría/nombre); las filas con un SKU nuevo se agrupan por
 * nombre de producto (mismo nombre = mismo producto, una fila por
 * variante) antes de crear — así un CSV con varias tallas/colores del
 * mismo producto genera un solo producto con N variantes, igual que el
 * alta manual, en vez de N productos sueltos de una variante cada uno.
 * Nunca aborta la carga completa por una fila mala — la reporta y sigue.
 * Recibe las filas ya revisadas/editadas por el admin en la
 * previsualización, no vuelve a leer el archivo.
 */
export async function confirmarImportacionCsv(
  allyId: string,
  rows: {
    sku: string;
    name: string;
    price: string;
    stock: string;
    talla: string;
    color: string;
    categoryId: string;
    description: string;
    imageUrl: string;
  }[],
): Promise<{ creados: number; actualizados: number; errores: { row: number; message: string }[] }> {
  const errores: { row: number; message: string }[] = [];
  let creados = 0;
  let actualizados = 0;

  const gruposNuevos = new Map<
    string,
    {
      rowNumber: number;
      sku: string;
      talla: string;
      color: string;
      price: number;
      stock: number;
      categoryId: string;
      description: string;
      imageUrl: string;
    }[]
  >();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rowNumber = i + 1;
    const sku = row.sku.trim();
    if (!sku) {
      errores.push({ row: rowNumber, message: "Falta el SKU." });
      continue;
    }
    const price = Number.parseFloat(row.price);
    const stock = Number.parseInt(row.stock, 10);
    if (!Number.isFinite(price) || price < 0) {
      errores.push({ row: rowNumber, message: `Precio inválido para el SKU ${sku}.` });
      continue;
    }
    if (!Number.isInteger(stock) || stock < 0) {
      errores.push({ row: rowNumber, message: `Stock inválido para el SKU ${sku}.` });
      continue;
    }

    const existing = await findVariantBySku(sku);
    if (existing) {
      await updateVariantStockAndPrice(existing.id, price, stock);
      actualizados++;
      continue;
    }

    const name = row.name.trim();
    if (!name) {
      errores.push({ row: rowNumber, message: `Falta el nombre para el SKU nuevo ${sku}.` });
      continue;
    }
    const grupo = gruposNuevos.get(name) ?? [];
    grupo.push({
      rowNumber,
      sku,
      talla: row.talla,
      color: row.color,
      price,
      stock,
      categoryId: row.categoryId,
      description: row.description,
      imageUrl: row.imageUrl,
    });
    gruposNuevos.set(name, grupo);
  }

  for (const [name, variantes] of gruposNuevos) {
    try {
      // La categoría, descripción e imagen del producto son las de la
      // primera fila del grupo — un producto tiene un solo valor de cada
      // uno, no uno por variante (ver hint del modal de previsualización).
      const primera = variantes[0]!;
      const categoryId = primera.categoryId.trim();
      await createProduct({
        name,
        description: primera.description.trim() || null,
        imageUrl: primera.imageUrl.trim() || null,
        allyId,
        categoryId: categoryId === "" ? null : categoryId,
        variants: variantes.map((v) => ({
          sku: v.sku,
          attributes: buildVariantAttributes(v.talla, v.color),
          price: v.price,
          stock: v.stock,
        })),
      });
      creados += variantes.length;
    } catch (error) {
      const message = productUniqueViolationMessage(error);
      for (const v of variantes) {
        errores.push({ row: v.rowNumber, message });
      }
    }
  }

  return { creados, actualizados, errores };
}

export async function renderPedidosPage(admin: AdminRecord): Promise<string | null> {
  const tenant = await getSettings();
  if (!tenant) {
    return null;
  }

  const rows = await withTransaction(async (client) => {
    const result = await client.query<PedidoRow>(
      `SELECT o.id, o.status, o.payment_method, o.delivery_method, o.total, o.created_at,
              o.delivery_address, o.delivery_id_document,
              c.phone_number, c.name AS customer_name,
              COALESCE(
                json_agg(json_build_object('name', p.name, 'quantity', oi.quantity, 'unit_price', oi.unit_price))
                  FILTER (WHERE oi.id IS NOT NULL),
                '[]'
              ) AS items
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN product_variants pv ON pv.id = oi.variant_id
       LEFT JOIN products p ON p.id = pv.product_id
       GROUP BY o.id, o.status, o.payment_method, o.delivery_method, o.total, o.created_at, o.delivery_address, o.delivery_id_document, c.phone_number, c.name
       ORDER BY o.created_at DESC`,
    );
    return result.rows;
  });

  const tableRows = rows
    .map((row) => {
      const items = row.items
        .map((item) => `<li>${item.quantity}× ${escapeHtml(item.name)} (${formatCOP(item.unit_price)})</li>`)
        .join("");
      const entrega =
        row.delivery_address || row.delivery_id_document
          ? `<p class="hint">Entrega a: ${escapeHtml(row.delivery_address ?? "-")} · Cédula ${escapeHtml(row.delivery_id_document ?? "-")}</p>`
          : "";
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
        <td><ul class="items">${items}</ul>${entrega}</td>
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
      </div>
      <table data-resizable-table="pedidos">
        <colgroup>
          <col style="width:15%"><col style="width:28%"><col style="width:11%">
          <col style="width:14%"><col style="width:14%"><col style="width:9%"><col style="width:9%">
        </colgroup>
        <thead><tr><th>Cliente</th><th>Items</th><th>Estado</th><th>Pago</th><th>Entrega</th><th>Total</th><th>Fecha</th></tr></thead>
        <tbody>${tableRows || `<tr><td colspan="7">${emptyState(ICON_PEDIDOS, "Sin pedidos todavía", "Se registra un pedido apenas un cliente confirme una compra por WhatsApp.")}</td></tr>`}</tbody>
      </table>
      <div class="pager">
        <span class="hint tabular"><span data-table-count>${rows.length}</span> de ${rows.length}</span>
        <div class="pager__controls" data-table-pager>
        <button type="button" data-table-prev aria-label="Página anterior">‹</button>
        <span class="tabular" data-table-pagelabel>1 / 1</span>
        <button type="button" data-table-next aria-label="Página siguiente">›</button>
        </div>
      </div>
    </div>
  `;

  return layout(`Pedidos (${rows.length})`, tenant, body, "pedidos", admin);
}

/**
 * Aliados (Fase 14, ver ADR-026) — proveedores externos (ej. "Ramos") a
 * los que se les puede anclar una promoción exclusiva (Fase 17). El aliado
 * genérico ("Catálogo propio", sembrado en la migración 0039) también
 * aparece acá y puede editarse como cualquier otro, pero no tiene un
 * tratamiento especial en esta vista — desactivarlo no tiene sentido de
 * negocio real (dejaría sin aliado válido a los productos propios), pero
 * no se bloquea explícitamente: es una decisión operativa, no una regla
 * que valga la pena codificar de antemano.
 */
export async function renderAliadosPage(
  admin: AdminRecord,
  query: { error?: string; guardado?: string },
): Promise<string | null> {
  const tenant = await getSettings();
  if (!tenant) {
    return null;
  }

  const [allies, productCounts] = await Promise.all([listAllies(), countProductsPerAlly()]);

  const banner = query.error
    ? `<div class="banner banner--error">${escapeHtml(query.error)}</div>`
    : query.guardado
      ? `<div class="banner banner--ok">Cambios guardados.</div>`
      : "";

  const allyDialogFields = (dialogId: string, name: string, contactInfo: string): string => `
        <div class="field">
          <label for="${dialogId}-nombre">Nombre</label>
          <input type="text" id="${dialogId}-nombre" name="name" required value="${escapeHtml(name)}">
        </div>
        <div class="field">
          <label for="${dialogId}-contacto">Contacto</label>
          <input type="text" id="${dialogId}-contacto" name="contactInfo" placeholder="Teléfono, correo, contacto…" value="${escapeHtml(contactInfo)}">
        </div>`;

  const rows = allies
    .map((ally) => {
      const formId = `aliado-${ally.id}`;
      const editarDialogId = `editar-aliado-${ally.id}`;
      const productCount = productCounts[ally.id] ?? 0;
      const search = [ally.name, ally.contactInfo].filter((v): v is string => Boolean(v)).join(" ").toLowerCase();

      return `<tr data-search="${escapeHtml(search)}" data-filter-estado="${ally.active ? "activo" : "inactivo"}" data-sort-name="${escapeHtml(ally.name.toLowerCase())}" data-sort-contacto="${escapeHtml((ally.contactInfo ?? "").toLowerCase())}" data-sort-productos="${productCount}" data-sort-estado="${ally.active ? 1 : 0}">
        <td class="dblclick-cell">
          <form id="${formId}" method="POST" action="/admin/aliados/${ally.id}">
            <input type="text" name="name" value="${escapeHtml(ally.name)}" required>
          </form>
        </td>
        <td class="dblclick-cell"><input type="text" name="contactInfo" form="${formId}" value="${escapeHtml(ally.contactInfo ?? "")}" placeholder="Teléfono, correo, contacto…"></td>
        <td><a class="countbadge" href="/admin/productos?allyId=${ally.id}"><strong>${productCount}</strong> ${productCount === 1 ? "producto" : "productos"}</a></td>
        <td>${statusToggleHtml(`/admin/aliados/${ally.id}`, ally.active, `el aliado "${ally.name}"`, "Activo", "Inactivo")}</td>
        <td><div class="rowactions">
          <button type="submit" form="${formId}" class="btn btn--ghost btn--icon" aria-label="Guardar cambios" title="Guardar cambios">${ICON_SAVE}</button>
          <button type="button" data-open-dialog="${editarDialogId}" class="btn btn--ghost btn--icon" aria-label="Editar aliado" title="Editar aliado">${ICON_EDIT}</button>
        </div></td>
      </tr>
      <dialog id="${editarDialogId}" class="modal">
        <div class="blockhead"><h2>Editar ${escapeHtml(ally.name)}</h2></div>
        <form method="POST" action="/admin/aliados/${ally.id}">
          ${allyDialogFields(editarDialogId, ally.name, ally.contactInfo ?? "")}
          <div class="formfoot">
            <button type="submit" class="btn btn--primary">Guardar cambios</button>
            <button type="button" data-close-dialog="${editarDialogId}" class="btn btn--ghost">Cancelar</button>
          </div>
        </form>
      </dialog>`;
    })
    .join("\n");

  const body = `
    <div class="pagehead">
      <p class="eyebrow">Catálogo</p>
      <h1>Aliados</h1>
      <p>Proveedores externos de ${escapeHtml(brandName(tenant))} — se les puede asignar un producto o anclar promociones exclusivas.</p>
    </div>
    ${banner}
    <div class="panel tablewrap" data-table data-page-size="20">
      <div class="tabletools">
        <input type="search" class="searchbox" data-table-search placeholder="Buscar por nombre o contacto…" aria-label="Buscar aliados">
        <select class="tablefilter" data-table-filter data-filter-key="estado" aria-label="Filtrar por estado">
          <option value="">Todos los estados</option>
          <option value="activo">Activos</option>
          <option value="inactivo">Inactivos</option>
        </select>
        <div class="tabletools__actions">
          <button type="button" data-open-dialog="nuevo-aliado-dialog" class="btn btn--add" aria-label="Agregar aliado"><span class="btn--add__plus">+</span> Nuevo aliado</button>
        </div>
      </div>
      <table>
        <colgroup>
          <col style="width:28%"><col style="width:26%">
          <col style="width:16%"><col style="width:16%"><col style="width:14%">
        </colgroup>
        <thead><tr>
          <th class="sortable" data-sort-key="name">Nombre</th>
          <th class="sortable" data-sort-key="contacto">Contacto</th>
          <th class="sortable" data-sort-key="productos">Productos</th>
          <th class="sortable" data-sort-key="estado">Estado</th>
          <th>Acciones</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="5">${emptyState(ICON_ALIADOS, "Sin aliados todavía", "Creá el primero con el botón de arriba.")}</td></tr>`}</tbody>
      </table>
      <div class="pager">
        <span class="hint tabular"><span data-table-count>${allies.length}</span> de ${allies.length}</span>
        <div class="pager__controls" data-table-pager>
          <button type="button" data-table-prev aria-label="Página anterior">‹</button>
          <span class="tabular" data-table-pagelabel>1 / 1</span>
          <button type="button" data-table-next aria-label="Página siguiente">›</button>
        </div>
      </div>
    </div>
    <dialog id="nuevo-aliado-dialog" class="modal">
      <div class="blockhead"><h2>Nuevo aliado</h2></div>
      <form method="POST" action="/admin/aliados">
        ${allyDialogFields("nuevo-aliado", "", "")}
        <div class="formfoot">
          <button type="submit" class="btn btn--primary">Crear aliado</button>
          <button type="button" data-close-dialog="nuevo-aliado-dialog" class="btn btn--ghost">Cancelar</button>
        </div>
      </form>
    </dialog>
  `;

  return layout("Aliados", tenant, body, "aliados", admin);
}

export async function crearAliado(input: {
  name: string;
  contactInfo: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) {
    return { ok: false, error: "El nombre del aliado es obligatorio." };
  }
  await createAlly(name, input.contactInfo.trim() || null);
  return { ok: true };
}

export async function guardarAliado(
  allyId: string,
  input: { name: string; contactInfo: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) {
    return { ok: false, error: "El nombre del aliado es obligatorio." };
  }
  await updateAlly(allyId, { name, contactInfo: input.contactInfo.trim() || null });
  return { ok: true };
}

export async function activarAliado(allyId: string): Promise<void> {
  await setAllyActive(allyId, true);
}

export async function desactivarAliado(allyId: string): Promise<void> {
  await setAllyActive(allyId, false);
}

/** Recorre la cadena de `parentId` hasta la raíz — usado para el breadcrumb de la tabla y para impedir ciclos al reasignar el padre de una categoría. */
function categoryPath(categories: CategoryRecord[], categoryId: string): string[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const path: string[] = [];
  let current = byId.get(categoryId);
  while (current) {
    path.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

/** `candidateId` es la misma categoría que `ofId`, o una de sus categorías descendientes — impide crear un ciclo en el árbol al reasignar `parent_id`. */
function isSelfOrDescendant(categories: CategoryRecord[], candidateId: string, ofId: string): boolean {
  if (candidateId === ofId) {
    return true;
  }
  const byId = new Map(categories.map((c) => [c.id, c]));
  let current = byId.get(candidateId);
  while (current?.parentId) {
    if (current.parentId === ofId) {
      return true;
    }
    current = byId.get(current.parentId);
  }
  return false;
}

/**
 * Categorías (Fase 14, ver ADR-026) — árbol de profundidad libre. Cada fila
 * edita nombre/padre/orden/complementarias en un mismo formulario
 * (`guardarCategoria`), Activar/Desactivar queda como acción aparte (mismo
 * criterio que Colaboradores/Aliados: el estado no se mezcla con el resto
 * de los campos editables).
 */
/** Modal de edición de categoría — padre/orden/complementarias, campos que ya no viven siempre visibles en la fila (ver renderCategoriasPage). El nombre se edita por doble clic en la fila misma, no acá, para no duplicar el control. */
function categoriaEditDialogHtml(
  category: CategoryRecord,
  categories: CategoryRecord[],
  selectedComplements: Set<string>,
): string {
  const dialogId = `editar-categoria-${category.id}`;
  const parentOptions =
    `<option value=""${category.parentId === null ? " selected" : ""}>— Categoría raíz —</option>` +
    categories
      .filter((c) => !isSelfOrDescendant(categories, c.id, category.id))
      .map(
        (c) =>
          `<option value="${c.id}"${c.id === category.parentId ? " selected" : ""}>${escapeHtml(categoryPath(categories, c.id).join(" › "))}</option>`,
      )
      .join("");
  const complementOptions = categories
    .filter((c) => c.id !== category.id)
    .map(
      (c) =>
        `<option value="${c.id}"${selectedComplements.has(c.id) ? " selected" : ""}>${escapeHtml(c.name)}</option>`,
    )
    .join("");

  return `<dialog id="${dialogId}" class="modal">
    <div class="blockhead"><h2>Editar ${escapeHtml(category.name)}</h2></div>
    <form method="POST" action="/admin/categorias/${category.id}">
      <input type="hidden" name="name" value="${escapeHtml(category.name)}">
      <div class="field">
        <label for="${dialogId}-padre">Categoría padre</label>
        <select id="${dialogId}-padre" name="parentId">${parentOptions}</select>
      </div>
      <div class="field">
        <label for="${dialogId}-orden">Orden entre hermanas</label>
        <input type="number" id="${dialogId}-orden" name="sortOrder" value="${category.sortOrder}">
      </div>
      <div class="field">
        <label for="${dialogId}-complementarias">Categorías complementarias</label>
        <select id="${dialogId}-complementarias" name="complementIds" multiple size="5">${complementOptions}</select>
        <p class="hint">El asistente las sugiere juntas (ej. Cascos ↔ Guantes). Ctrl/Cmd+clic para elegir varias.</p>
      </div>
      <div class="formfoot">
        <button type="submit" class="btn btn--primary">Guardar cambios</button>
        <button type="button" data-close-dialog="${dialogId}" class="btn btn--ghost">Cancelar</button>
      </div>
    </form>
  </dialog>`;
}

export async function renderCategoriasPage(
  admin: AdminRecord,
  query: { error?: string; guardado?: string },
): Promise<string | null> {
  const tenant = await getSettings();
  if (!tenant) {
    return null;
  }

  const [categories, complementPairs, productCounts] = await Promise.all([
    listCategories(),
    listAllComplementPairs(),
    countProductsPerCategory(),
  ]);

  const complementsByCategory = new Map<string, string[]>();
  for (const pair of complementPairs) {
    const list = complementsByCategory.get(pair.categoryId) ?? [];
    list.push(pair.complementaryCategoryId);
    complementsByCategory.set(pair.categoryId, list);
  }
  const childrenByParent = new Set(categories.filter((c) => c.parentId !== null).map((c) => c.parentId!));

  const banner = query.error
    ? `<div class="banner banner--error">${escapeHtml(query.error)}</div>`
    : query.guardado
      ? `<div class="banner banner--ok">Cambios guardados.</div>`
      : "";

  const treeOrder = categoryTreeOrder(categories);
  const orderedCategories = treeOrder
    .map((node) => ({ category: categories.find((c) => c.id === node.id), depth: node.depth }))
    .filter(
      (n): n is { category: CategoryRecord; depth: number } => n.category !== undefined,
    );

  const rows = orderedCategories
    .map(({ category, depth }) => {
      const formId = `categoria-${category.id}`;
      const editarDialogId = `editar-categoria-${category.id}`;
      const selectedComplements = new Set(complementsByCategory.get(category.id) ?? []);
      const productCount = productCounts[category.id] ?? 0;
      const hasChildren = childrenByParent.has(category.id);
      const guides = Array.from({ length: depth }, () => `<span class="cattree__guide"></span>`).join("");
      const toggle = hasChildren
        ? `<button type="button" class="cattree__toggle" data-cat-toggle aria-label="Colapsar o expandir">${ICON_CHEVRON}</button>`
        : `<span class="cattree__spacer"></span>`;
      const complementTags = [...selectedComplements]
        .map((id) => categories.find((c) => c.id === id)?.name)
        .filter((name): name is string => Boolean(name))
        .map((name) => `<span class="tag">${escapeHtml(name)}</span>`)
        .join("");

      return `<tr class="cattree__row" data-cat-row="${category.id}" data-cat-parent="${category.parentId ?? ""}" data-cat-active="${category.active}" data-cat-search="${escapeHtml(category.name.toLowerCase())}">
        <td>
          <div class="cattree__branch">${guides}${toggle}
            <form id="${formId}" method="POST" action="/admin/categorias/${category.id}">
              <input type="hidden" name="parentId" value="${category.parentId ?? ""}">
              <input type="hidden" name="sortOrder" value="${category.sortOrder}">
              ${[...selectedComplements].map((id) => `<input type="hidden" name="complementIds[]" value="${id}">`).join("")}
              <input type="text" name="name" class="cattree__name" value="${escapeHtml(category.name)}" required>
            </form>
          </div>
        </td>
        <td><a class="countbadge" href="/admin/productos?categoryId=${category.id}"><strong>${productCount}</strong> ${productCount === 1 ? "producto" : "productos"}</a></td>
        <td>${complementTags || '<span class="hint">—</span>'}</td>
        <td>${statusToggleHtml(`/admin/categorias/${category.id}`, category.active, `la categoría "${category.name}"`, "Activa", "Inactiva")}</td>
        <td><div class="rowactions">
          <button type="submit" form="${formId}" class="btn btn--ghost btn--icon" aria-label="Guardar cambios" title="Guardar cambios">${ICON_SAVE}</button>
          <button type="button" data-open-dialog="${editarDialogId}" class="btn btn--ghost btn--icon" aria-label="Editar categoría" title="Editar categoría">${ICON_EDIT}</button>
        </div></td>
      </tr>
      ${categoriaEditDialogHtml(category, categories, selectedComplements)}`;
    })
    .join("\n");

  const rootParentOptions =
    `<option value="">— Categoría raíz —</option>` +
    orderedCategories
      .map(
        ({ category }) =>
          `<option value="${category.id}">${escapeHtml(categoryPath(categories, category.id).join(" › "))}</option>`,
      )
      .join("");

  const body = `
    <div class="pagehead">
      <p class="eyebrow">Catálogo</p>
      <h1>Categorías</h1>
      <p>Árbol de categorías de ${escapeHtml(brandName(tenant))} — profundidad libre, sin límite de niveles.</p>
    </div>
    ${banner}
    <div class="panel tablewrap">
      <div class="tabletools">
        <input type="search" class="searchbox" data-cattree-search placeholder="Buscar categoría…" aria-label="Buscar categorías">
        <select class="tablefilter" data-cattree-estado aria-label="Filtrar por estado">
          <option value="">Todas</option>
          <option value="activas">Activas</option>
          <option value="inactivas">Inactivas</option>
        </select>
        <div class="tabletools__actions">
          <button type="button" data-open-dialog="nueva-categoria-dialog" class="btn btn--add" aria-label="Agregar categoría"><span class="btn--add__plus">+</span> Nueva categoría</button>
        </div>
      </div>
      <table data-cattree>
        <colgroup>
          <col style="width:32%"><col style="width:12%">
          <col style="width:19%"><col style="width:20%"><col style="width:17%">
        </colgroup>
        <thead><tr><th>Categoría</th><th>Productos</th><th>Complementarias</th><th>Estado</th><th>Acciones</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5">${emptyState(ICON_CATEGORIAS, "Sin categorías todavía", "Creá la primera con el botón de arriba.")}</td></tr>`}</tbody>
      </table>
    </div>
    <dialog id="nueva-categoria-dialog" class="modal">
      <div class="blockhead"><h2>Nueva categoría</h2></div>
      <form method="POST" action="/admin/categorias">
        <div class="field">
          <label for="nueva-categoria-nombre">Nombre</label>
          <input type="text" id="nueva-categoria-nombre" name="name" required>
        </div>
        <div class="field">
          <label for="nueva-categoria-padre">Categoría padre</label>
          <select id="nueva-categoria-padre" name="parentId">${rootParentOptions}</select>
        </div>
        <div class="field">
          <label for="nueva-categoria-orden">Orden</label>
          <input type="number" id="nueva-categoria-orden" name="sortOrder" value="0">
        </div>
        <div class="formfoot">
          <button type="submit" class="btn btn--primary">Crear categoría</button>
          <button type="button" data-close-dialog="nueva-categoria-dialog" class="btn btn--ghost">Cancelar</button>
        </div>
      </form>
    </dialog>
  `;

  return layout("Categorías", tenant, body, "categorias", admin);
}

export async function crearCategoria(input: {
  name: string;
  parentId: string;
  sortOrder: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) {
    return { ok: false, error: "El nombre de la categoría es obligatorio." };
  }
  const sortOrder = Number.parseInt(input.sortOrder, 10);
  if (!Number.isInteger(sortOrder)) {
    return { ok: false, error: "El orden debe ser un número entero." };
  }
  await createCategory(name, input.parentId === "" ? null : input.parentId, sortOrder);
  return { ok: true };
}

export async function guardarCategoria(
  categoryId: string,
  input: { name: string; parentId: string; sortOrder: string; complementIds: string[] },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) {
    return { ok: false, error: "El nombre de la categoría es obligatorio." };
  }
  const sortOrder = Number.parseInt(input.sortOrder, 10);
  if (!Number.isInteger(sortOrder)) {
    return { ok: false, error: "El orden debe ser un número entero." };
  }
  const parentId = input.parentId === "" ? null : input.parentId;
  if (parentId !== null) {
    const categories = await listCategories();
    if (isSelfOrDescendant(categories, parentId, categoryId)) {
      return {
        ok: false,
        error: "No podés asignar como padre a la misma categoría o a una de sus propias subcategorías.",
      };
    }
  }
  await updateCategory(categoryId, { name, parentId, sortOrder });
  await setComplements(categoryId, input.complementIds);
  return { ok: true };
}

export async function activarCategoria(categoryId: string): Promise<void> {
  await setCategoryActive(categoryId, true);
}

export async function desactivarCategoria(categoryId: string): Promise<void> {
  await setCategoryActive(categoryId, false);
}

/**
 * Colaboradores (Fase 13, ver ADR-025) — solo visible/accionable para un
 * admin `role='master'`; el hook de auth de server.ts no filtra esto (solo
 * exige sesión válida), así que el propio route handler de
 * `GET /admin/colaboradores` debe rechazar a un no-master antes
 * de llamar a esta función (ver server.ts).
 */
export async function renderColaboradoresPage(
  admin: AdminRecord,
  query: { error?: string; guardado?: string },
): Promise<string | null> {
  const currentAdminId = admin.id;
  const tenant = await getSettings();
  if (!tenant) {
    return null;
  }

  const admins = await listAdmins();

  const banner = query.error
    ? `<div class="banner banner--error">${escapeHtml(query.error)}</div>`
    : query.guardado
      ? `<div class="banner banner--ok">Cambios guardados.</div>`
      : "";

  const permisoCheckbox = (
    adminId: string,
    name: keyof AdminPermissions,
    label: string,
    checked: boolean,
    disabled: boolean,
  ): string =>
    `<label class="permcheck"><input type="checkbox" name="${name}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}>${escapeHtml(label)}</label>`;

  const rows = admins
    .map((row) => {
      const isSelf = row.id === currentAdminId;
      const isMasterRow = row.role === "master";
      const rowAvatar = row.avatarData
        ? `<img src="${escapeHtml(row.avatarData)}" class="avatar avatar--sm" alt="">`
        : `<span class="avatar avatar--sm avatar--initial">${escapeHtml(row.username.charAt(0).toUpperCase())}</span>`;
      const roleChip = isMasterRow
        ? '<span class="chip chip--amber">Master</span>'
        : '<span class="chip chip--muted">Colaborador</span>';
      const estadoChip = row.active
        ? '<span class="chip chip--go">Activo</span>'
        : '<span class="chip chip--redline">Inactivo</span>';

      // Un master siempre tiene todos los permisos implícitos (ver
      // resolveEffectivePermissions en adminsDirectory.ts) — los checkbox
      // se muestran tildados y deshabilitados para no sugerir que se
      // pueden editar sin efecto real. El botón "Guardar" NO vive adentro
      // de este <form> — se conecta por el atributo `form="..."` desde la
      // columna de Acciones, para que todos los botones de la fila queden
      // juntos en la última columna (pedido explícito) sin que HTML exija
      // que el submit esté anidado dentro del <form>.
      const permisosFormId = `permisos-${row.id}`;
      const permisosForm = `
        <form id="${permisosFormId}" method="POST" action="/admin/colaboradores/${row.id}/permisos" class="permform">
          ${permisoCheckbox(row.id, "recibeReporteDiario", "Reporte del asistente", row.permissions.recibeReporteDiario, isMasterRow)}
          ${permisoCheckbox(row.id, "recibeTickets", "Tickets nuevos", row.permissions.recibeTickets, isMasterRow)}
          ${permisoCheckbox(row.id, "recibeNotificacionPagos", "Pagos aprobados", row.permissions.recibeNotificacionPagos, isMasterRow)}
        </form>
      `;
      const guardarPermisosBtn = isMasterRow
        ? ""
        : `<button type="submit" form="${permisosFormId}" class="btn btn--primary btn--sm">Guardar</button>`;

      // El color del botón sigue la acción que va a EJECUTAR, no el estado
      // actual de la fila (que ya lo dice el chip de al lado): "Desactivar"
      // en rojo porque es la acción destructiva, "Activar" en verde porque
      // habilita de nuevo — mismo criterio semántico que --go/--redline en
      // el resto del tablero.
      const estadoAction = isSelf
        ? '<span class="hint">Vos</span>'
        : `<form method="POST" action="/admin/colaboradores/${row.id}/${row.active ? "desactivar" : "activar"}">
             <button type="submit" class="btn ${row.active ? "btn--danger" : "btn--go"} btn--sm">${row.active ? "Desactivar" : "Activar"}</button>
           </form>`;

      return `<tr>
        <td><div class="avatarrow">${rowAvatar}<span>${escapeHtml(row.username)}</span></div></td>
        <td>${escapeHtml(row.email)}</td>
        <td class="mono">${row.phone ? escapeHtml(row.phone) : '<span class="hint">Sin teléfono</span>'}</td>
        <td>${roleChip}</td>
        <td>${estadoChip}</td>
        <td>${permisosForm}</td>
        <td><div class="rowactions">${guardarPermisosBtn}${estadoAction}</div></td>
      </tr>`;
    })
    .join("\n");

  const body = `
    <div class="pagehead">
      <p class="eyebrow">Equipo</p>
      <h1>Colaboradores</h1>
      <p>Cuentas con acceso al panel de ${escapeHtml(brandName(tenant))}.</p>
    </div>
    ${banner}
    <div class="panel tablewrap">
      <div class="blockhead blockhead--end">
        <button type="button" data-open-dialog="nuevo-colaborador-dialog" class="btn btn--primary btn--icon" aria-label="Agregar colaborador" title="Agregar colaborador">${ICON_PLUS}</button>
      </div>
      <table>
        <thead><tr><th>Usuario</th><th>Correo</th><th>Teléfono</th><th>Rol</th><th>Estado</th><th>Notificaciones</th><th>Acciones</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7">${emptyState(ICON_COLABORADORES, "Sin colaboradores todavía", "Creá el primero con el botón de arriba.")}</td></tr>`}</tbody>
      </table>
    </div>
    <dialog id="nuevo-colaborador-dialog" class="modal">
      <div class="blockhead"><h2>Nuevo colaborador</h2></div>
      <form method="POST" action="/admin/colaboradores">
        <div class="field">
          <label for="nuevo-username">Usuario</label>
          <div class="fieldcheck">
            <input type="text" id="nuevo-username" name="username" required pattern="[a-z0-9._-]{5,32}" placeholder="ana.perez" data-validate="username">
            <span class="fieldcheck__light" data-fieldcheck-light aria-hidden="true"></span>
          </div>
          <p class="fieldcheck__msg" data-fieldcheck-msg></p>
        </div>
        <div class="field">
          <label for="email">Correo</label>
          <div class="fieldcheck">
            <input type="email" id="email" name="email" required data-validate="email">
            <span class="fieldcheck__light" data-fieldcheck-light aria-hidden="true"></span>
          </div>
          <p class="fieldcheck__msg" data-fieldcheck-msg></p>
        </div>
        <div class="field">
          <label for="password">Contraseña</label>
          <div class="fieldcheck">
            <input type="password" id="password" name="password" required minlength="8" data-validate="password">
            <span class="fieldcheck__light" data-fieldcheck-light aria-hidden="true"></span>
          </div>
          <p class="fieldcheck__msg" data-fieldcheck-msg></p>
        </div>
        <div class="field">
          <label for="phone-number">Teléfono (WhatsApp)</label>
          <div class="phonerow">
            <select id="phone-prefix" name="phonePrefix" aria-label="País" autocomplete="off">${phoneCountryOptions(DEFAULT_PHONE_COUNTRY_CODE)}</select>
            <input type="text" id="phone-number" name="phoneNumber" inputmode="numeric" placeholder="3001234567">
          </div>
          <p class="hint">Para las notificaciones que le actives abajo. Se puede dejar vacío y cargar después.</p>
        </div>
        <div class="field">
          <label id="role-label">Rol</label>
          <div class="choicegrid" role="radiogroup" aria-labelledby="role-label">
            <label class="choice">
              <input type="radio" name="role" value="colaborador" checked>
              <span class="choice__card">
                <span class="choice__title">Colaborador</span>
                <span class="choice__desc">Ve el panel, recibe solo las notificaciones que le marques.</span>
              </span>
            </label>
            <label class="choice">
              <input type="radio" name="role" value="master">
              <span class="choice__card">
                <span class="choice__title">Master</span>
                <span class="choice__desc">Todos los permisos, puede gestionar colaboradores.</span>
              </span>
            </label>
          </div>
        </div>
        <div class="formfoot">
          <button type="submit" class="btn btn--primary">Crear colaborador</button>
          <button type="button" data-close-dialog="nuevo-colaborador-dialog" class="btn btn--ghost">Cancelar</button>
        </div>
      </form>
    </dialog>
  `;

  return layout("Colaboradores", tenant, body, "colaboradores", admin);
}

// username: minúsculas, números, punto/guión/guión bajo, 5-32 caracteres —
// habilita el login combinado (ver adminsDirectory.ts
// findAdminByUsernameOrEmail) además del correo.
const USERNAME_RE = /^[a-z0-9._-]{5,32}$/;

/**
 * Mensaje específico según qué UNIQUE violó (username/email/phone, ver
 * migrations/0036 y 0037) — genérico si no fue un unique_violation (23505)
 * o no se pudo determinar cuál constraint. `context` cambia la redacción
 * entre "creando un colaborador" (crearColaborador, ve el master) y
 * "editando el propio perfil" (guardarPerfil, ve cualquier admin) sin
 * duplicar la lógica de mapeo de constraint → mensaje.
 */
function uniqueViolationMessage(error: unknown, context: "colaborador" | "perfil" = "colaborador"): string {
  const pgError = error instanceof Error ? (error as { code?: string; constraint?: string }) : undefined;
  if (pgError?.code !== "23505") {
    return context === "perfil" ? "No se pudo guardar el perfil." : "No se pudo crear el colaborador.";
  }
  if (context === "perfil") {
    if (pgError.constraint === "admins_username_key") {
      return "Ese nombre de usuario ya está en uso.";
    }
    if (pgError.constraint === "admins_phone_key") {
      return "Ese teléfono ya está en uso por otra cuenta.";
    }
    return "Ese correo ya está en uso por otra cuenta.";
  }
  if (pgError.constraint === "admins_username_key") {
    return "Ya existe un colaborador con ese nombre de usuario.";
  }
  if (pgError.constraint === "admins_phone_key") {
    return "Ya existe un colaborador con ese teléfono.";
  }
  return "Ya existe un colaborador con ese correo.";
}

export async function crearColaborador(
  input: {
    username: string;
    email: string;
    password: string;
    role: string;
    phonePrefix: string;
    phoneNumber: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const username = input.username.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return {
      ok: false,
      error: "Nombre de usuario inválido: 5 a 32 caracteres, minúsculas, números, puntos o guiones.",
    };
  }
  const email = input.email.trim().toLowerCase();
  if (!email) {
    return { ok: false, error: "El correo es obligatorio." };
  }
  if (input.password.length < 8) {
    return { ok: false, error: "La contraseña debe tener al menos 8 caracteres." };
  }
  if (!isAdminRole(input.role)) {
    return { ok: false, error: "Rol no válido." };
  }
  const rawNumber = input.phoneNumber.trim();
  if (rawNumber !== "" && !/^\d{4,12}$/.test(rawNumber.replace(/\D/g, ""))) {
    return { ok: false, error: "Ese número no parece válido — escribí solo los dígitos, sin el prefijo del país." };
  }
  const phone = buildWhatsappPhone(input.phonePrefix, rawNumber);

  const passwordHash = await hashPassword(input.password);
  try {
    await createAdmin(username, email, passwordHash, input.role, phone);
  } catch (error) {
    return { ok: false, error: uniqueViolationMessage(error) };
  }
  return { ok: true };
}

/**
 * Perfil propio (Fase 13 v2, ver ADR-032): cualquier admin — master o
 * colaborador por igual — edita acá su username/correo/teléfono/avatar y
 * cierra sesión. A diferencia de Colaboradores (solo master), esta ruta no
 * tiene ningún gate de rol — ver el hook de auth de server.ts.
 */
export async function renderPerfilPage(
  admin: AdminRecord,
  query: { error?: string; guardado?: string },
): Promise<string | null> {
  const tenant = await getSettings();
  if (!tenant) {
    return null;
  }

  const banner = query.error
    ? `<div class="banner banner--error">${escapeHtml(query.error)}</div>`
    : query.guardado
      ? `<div class="banner banner--ok">Cambios guardados.</div>`
      : "";

  const avatarValue = admin.avatarData ?? "";

  // El avatar entero es el disparador del <input type=file> oculto (ver
  // data-avatar-trigger en CLIENT_SCRIPT) — sin avatarData todavía se
  // muestran las iniciales, mismo criterio que el rail y la tabla de
  // Colaboradores. "Cerrar sesión" ya no vive acá: se movió al menú de
  // cuenta del rail (pedido explícito) para no tener que entrar al Perfil
  // solo para salir.
  const avatarPreview = avatarValue
    ? `<img data-avatar-preview src="${escapeHtml(avatarValue)}" alt="" class="avatar">`
    : `<span data-avatar-preview class="avatar avatar--initial">${escapeHtml(admin.username.charAt(0).toUpperCase())}</span>`;

  const { prefix: phonePrefix, number: phoneNumber } = splitWhatsappPhone(admin.phone);

  const body = `
    <div class="pagehead">
      <p class="eyebrow">Cuenta</p>
      <h1>Perfil</h1>
      <p>Tus datos de acceso a ${escapeHtml(brandName(tenant))}.</p>
    </div>
    ${banner}
    <div class="panel connection">
      <form method="POST" action="/admin/perfil">
        <div class="field">
          <label>Avatar</label>
          <button type="button" class="avatarpicker" data-avatar-trigger aria-label="Cambiar avatar">
            ${avatarPreview}
            <span class="avatarpicker__badge" aria-hidden="true">${ICON_EDIT}</span>
          </button>
          <input type="file" id="avatar-file" accept="image/*" data-avatar-input class="sr-only">
          <input type="hidden" name="avatarData" id="avatar-hidden" data-avatar-hidden value="${escapeHtml(avatarValue)}">
          <p class="hint">Tocá el avatar para cambiarlo — menos de 300 KB. Si no elegís uno nuevo, se mantiene el actual.</p>
        </div>
        <div class="field">
          <label for="perfil-username">Usuario</label>
          <div class="fieldcheck">
            <input type="text" id="perfil-username" name="username" required pattern="[a-z0-9._-]{5,32}" value="${escapeHtml(admin.username)}" data-validate="username" data-exclude-self="1">
            <span class="fieldcheck__light" data-fieldcheck-light aria-hidden="true"></span>
          </div>
          <p class="fieldcheck__msg" data-fieldcheck-msg></p>
        </div>
        <div class="field">
          <label for="perfil-email">Correo</label>
          <div class="fieldcheck">
            <input type="email" id="perfil-email" name="email" required value="${escapeHtml(admin.email)}" data-validate="email">
            <span class="fieldcheck__light" data-fieldcheck-light aria-hidden="true"></span>
          </div>
          <p class="fieldcheck__msg" data-fieldcheck-msg></p>
        </div>
        <div class="field">
          <label for="perfil-phone-number">Teléfono (WhatsApp)</label>
          <div class="phonerow">
            <select id="perfil-phone-prefix" name="phonePrefix" aria-label="País" autocomplete="off">${phoneCountryOptions(phonePrefix)}</select>
            <input type="text" id="perfil-phone-number" name="phoneNumber" inputmode="numeric" placeholder="3001234567" value="${escapeHtml(phoneNumber)}">
          </div>
        </div>
        <div class="formfoot"><button type="submit" class="btn btn--primary">Guardar cambios</button></div>
      </form>
    </div>
  `;

  return layout("Perfil", tenant, body, "perfil", admin);
}

// Ceiling defensivo para avatarData (Fase 13 v2): ~300 KB de imagen cruda
// infla a ~400 KB de string data-URL una vez codificada en base64 (factor
// ~4/3) — evita que alguien mande un archivo gigante y lo dejemos crecer
// sin límite en la columna text de admins.avatar_data.
const AVATAR_MAX_LENGTH = 400_000;

export async function guardarPerfil(
  admin: AdminRecord,
  input: { username: string; email: string; phonePrefix: string; phoneNumber: string; avatarData: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const username = input.username.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return {
      ok: false,
      error: "Nombre de usuario inválido: 5 a 32 caracteres, minúsculas, números, puntos o guiones.",
    };
  }
  const email = input.email.trim().toLowerCase();
  if (!email) {
    return { ok: false, error: "El correo es obligatorio." };
  }
  const rawNumber = input.phoneNumber.trim();
  if (rawNumber !== "" && !/^\d{4,12}$/.test(rawNumber.replace(/\D/g, ""))) {
    return { ok: false, error: "Ese número no parece válido — escribí solo los dígitos, sin el prefijo del país." };
  }
  const phone = buildWhatsappPhone(input.phonePrefix, rawNumber);
  const avatarData = input.avatarData === "" ? null : input.avatarData;
  if (avatarData !== null) {
    if (!avatarData.startsWith("data:image/")) {
      return { ok: false, error: "Avatar inválido." };
    }
    if (avatarData.length > AVATAR_MAX_LENGTH) {
      return { ok: false, error: "La imagen es muy pesada, usá una de menos de 300 KB." };
    }
  }

  try {
    await updateAdminProfile(admin.id, { username, email, phone, avatarData });
  } catch (error) {
    return { ok: false, error: uniqueViolationMessage(error, "perfil") };
  }
  return { ok: true };
}

export async function activarColaborador(adminId: string): Promise<void> {
  await setAdminActive(adminId, true);
}

export async function desactivarColaborador(adminId: string): Promise<void> {
  await setAdminActive(adminId, false);
}

export async function guardarPermisosColaborador(
  adminId: string,
  permissions: AdminPermissions,
): Promise<void> {
  await updateAdminPermissions(adminId, permissions);
}

/** Serializado para <script type="application/json"> — ver CLIENT_SCRIPT, filtro de Modelo según Proveedor. */
function llmCatalogForClient(): Record<ProviderKey, { models: { id: string; label: string }[]; keyPlaceholder: string }> {
  return Object.fromEntries(
    (Object.keys(PROVIDER_CATALOG) as ProviderKey[]).map((key) => [
      key,
      { models: PROVIDER_CATALOG[key].models, keyPlaceholder: PROVIDER_CATALOG[key].keyPlaceholder },
    ]),
  ) as Record<ProviderKey, { models: { id: string; label: string }[]; keyPlaceholder: string }>;
}

/**
 * Configuración (Fase 11.4, ver docs/fase-11-panel-admin-dashboard/
 * configuracion-comportamiento.md y ADR-020): kill-switch del bot +
 * proveedor/modelo de IA configurable por tenant (BYOK). Sin JS del lado
 * servidor con estado — errores/éxito del POST viajan por querystring tras
 * un redirect 303 (mismo patrón que /asesor/:token/tomar).
 */
export async function renderConfiguracionPage(
  query: { error?: string; guardado?: string },
  admin: AdminRecord,
): Promise<string | null> {
  const tenant = await getSettings();
  if (!tenant) {
    return null;
  }
  const llmConfig = await getLlmConfig();
  const behaviorConfig = resolveBehaviorConfig(await getBehaviorConfig());
  const reportRecipient = await getReportRecipient();
  const reportFrequencyDays = await getReportFrequencyDays();
  const reportFrequencyPreset =
    reportFrequencyDays === 1
      ? "diario"
      : reportFrequencyDays === 7
        ? "semanal"
        : reportFrequencyDays === 30
          ? "mensual"
          : "personalizado";
  const reportFrequencyCustomValue = reportFrequencyPreset === "personalizado" ? reportFrequencyDays : 14;
  const reviewLink = await getReviewLink();
  const wompiConfig = await getWompiConfig();
  const maskedWompiKey = wompiConfig.privateKey ? `••••${wompiConfig.privateKey.slice(-4)}` : null;
  const maskedEventsSecret = wompiConfig.eventsSecret ? `••••${wompiConfig.eventsSecret.slice(-4)}` : null;
  const currentProviderKey = llmConfig.provider && isProviderKey(llmConfig.provider) ? llmConfig.provider : null;
  const currentEntry = currentProviderKey ? PROVIDER_CATALOG[currentProviderKey] : null;
  const currentModel = llmConfig.model ?? currentEntry?.defaultModel ?? "";
  const maskedKey = llmConfig.apiKey ? `••••${llmConfig.apiKey.slice(-4)}` : null;

  const providerOptions = (Object.keys(PROVIDER_CATALOG) as ProviderKey[])
    .map((key) => {
      const entry = PROVIDER_CATALOG[key];
      const selected = key === currentProviderKey ? " selected" : "";
      return `<option value="${key}"${selected}>${escapeHtml(entry.label)}</option>`;
    })
    .join("\n");

  const keyHint = maskedKey
    ? `Ya hay una guardada: <span class="mono">${escapeHtml(maskedKey)}</span>. Dejar el campo vacío para conservarla.`
    : "Sin key propia — se prueba con la key del sistema del proveedor, si hay una disponible.";

  const banner = query.error
    ? `<div class="banner banner--error">${escapeHtml(query.error)}</div>`
    : query.guardado
      ? `<div class="banner banner--ok">Guardado. La configuración ya está activa para las próximas conversaciones.</div>`
      : "";

  const body = `
    <div class="pagehead">
      <p class="eyebrow">Agente</p>
      <h1>Configuración</h1>
      <p>Control de encendido del bot y el modelo de IA que responde por ${escapeHtml(brandName(tenant))}.</p>
    </div>
    ${banner}
    <section class="block block--narrow" aria-label="Estado del bot">
      <div class="blockhead"><h2>Estado del bot</h2></div>
      <div class="panel connection">
        <div class="connection__head">
          <h2>${tenant.bot_paused ? "Bot pausado" : "Bot activo"}</h2>
          <span class="connection__badge ${tenant.bot_paused ? "connection__badge--off" : "connection__badge--on"}">${tenant.bot_paused ? "Pausado" : '<span class="pulse"></span>Activo'}</span>
        </div>
        <p>${tenant.bot_paused ? "Los mensajes entrantes se guardan en el historial, pero el agente no responde automáticamente." : "El agente responde automáticamente a los mensajes entrantes por WhatsApp."}</p>
        <form method="POST" action="/admin/configuracion/${tenant.bot_paused ? "reactivar" : "pausar"}"${tenant.bot_paused ? "" : ` data-confirm="¿Pausar el bot de ${escapeHtml(brandName(tenant)).replace(/"/g, "&quot;")}? Los mensajes entrantes se seguirán guardando, pero no se responderá automáticamente hasta reactivarlo."`}>
          <div class="formfoot"><button type="submit" class="btn">${tenant.bot_paused ? "Reactivar bot" : "Pausar bot"}</button></div>
        </form>
      </div>
    </section>
    <section class="block block--narrow" aria-label="Modelo de IA">
      <div class="blockhead"><h2>Modelo de IA</h2><span class="hint">BYOK</span></div>
      <div class="panel connection">
        <form method="POST" action="/admin/configuracion/modelo-ia">
          <div class="field">
            <label for="llm-provider">Proveedor</label>
            <select id="llm-provider" name="provider" data-provider-select>
              <option value=""${currentProviderKey ? "" : " selected"}>Automático (recomendado)</option>
              ${providerOptions}
            </select>
            <p class="hint">Sin seleccionar, usa el proveedor y modelo por defecto de la plataforma.</p>
          </div>
          <div class="field">
            <label for="llm-routing-mode">Selección de modelo</label>
            <select id="llm-routing-mode" name="routingMode" data-routing-mode-select>
              <option value="manual"${llmConfig.routingMode === "manual" ? " selected" : ""}>Manual — elijo el modelo yo mismo</option>
              <option value="auto_dificultad"${llmConfig.routingMode === "auto_dificultad" ? " selected" : ""}>Automático según dificultad (Cerebro del bot)</option>
            </select>
            <p class="hint">"Cerebro del bot" usa el modelo más barato del proveedor para preguntas simples y el más potente para las difíciles — requiere elegir un proveedor arriba (no "Automático").</p>
          </div>
          <div class="field">
            <label for="llm-model">Modelo</label>
            <select id="llm-model" name="model" data-model-select data-initial-model="${escapeHtml(currentModel)}"></select>
          </div>
          <div class="field">
            <label for="llm-apikey">API key propia (opcional)</label>
            <input type="password" id="llm-apikey" name="apiKey" data-apikey-input autocomplete="off">
            <p class="hint">${keyHint}</p>
          </div>
          <div class="formfoot"><button type="submit" class="btn btn--primary">Probar y guardar</button></div>
        </form>
        <script type="application/json" id="llm-catalog-data">${JSON.stringify(llmCatalogForClient())}</script>
      </div>
    </section>
    <section class="block block--narrow" aria-label="Voz y estilo del agente">
      <div class="blockhead"><h2>Voz y estilo del agente</h2></div>
      <div class="panel connection">
        <form method="POST" action="/admin/configuracion/comportamiento">
          <div class="field">
            <label id="tono-label">Tono</label>
            <div class="choicegrid" role="radiogroup" aria-labelledby="tono-label">
              ${choiceCard("tono", "calido", behaviorConfig.tono, ICON_TONO_CALIDO, "Cálido", "Amable y cercano, como un amigo.")}
              ${choiceCard("tono", "formal", behaviorConfig.tono, ICON_TONO_FORMAL, "Formal", "Serio y profesional, trato de usted.")}
              ${choiceCard("tono", "divertido", behaviorConfig.tono, ICON_TONO_DIVERTIDO, "Divertido", "Relajado y con buen humor.")}
            </div>
          </div>
          <div class="field">
            <label id="estilo-mensajes-label">Estilo de mensajes</label>
            <div class="choicegrid" role="radiogroup" aria-labelledby="estilo-mensajes-label">
              ${choiceCard("estiloMensajes", "un_mensaje", behaviorConfig.estiloMensajes, ICON_ESTILO_UNO, "Un mensaje", "Toda la respuesta en una sola burbuja.")}
              ${choiceCard("estiloMensajes", "pocos_cortos", behaviorConfig.estiloMensajes, ICON_ESTILO_POCOS, "2-3 cortos", "Parte la respuesta en pocas burbujas.")}
              ${choiceCard("estiloMensajes", "varios_cortos", behaviorConfig.estiloMensajes, ICON_ESTILO_VARIOS, "Varios cortos", "Muchas burbujas, estilo chat.")}
            </div>
          </div>
          <div class="field">
            <label id="velocidad-respuesta-label">Velocidad de respuesta</label>
            <div class="choicegrid" role="radiogroup" aria-labelledby="velocidad-respuesta-label">
              ${choiceCard("velocidadRespuesta", "inmediato", behaviorConfig.velocidadRespuesta, ICON_VEL_INMEDIATO, "Inmediato", "Responde apenas llega el mensaje (recomendado).")}
              ${choiceCard("velocidadRespuesta", "rapido", behaviorConfig.velocidadRespuesta, ICON_VEL_RAPIDO, "Rápido", "Espera 5 segundos por si el cliente sigue escribiendo.")}
              ${choiceCard("velocidadRespuesta", "normal", behaviorConfig.velocidadRespuesta, ICON_VEL_NORMAL, "Normal", "Espera 15 segundos.")}
              ${choiceCard("velocidadRespuesta", "pausado", behaviorConfig.velocidadRespuesta, ICON_VEL_PAUSADO, "Pausado", "Espera 30 segundos para juntar todo el mensaje.")}
            </div>
            <p class="hint">Fuera de "Inmediato", el agente agrupa los mensajes seguidos del cliente en un solo turno de respuesta.</p>
          </div>
          <div class="formfoot"><button type="submit" class="btn btn--primary">Guardar</button></div>
        </form>
      </div>
    </section>
    <section class="block block--narrow" aria-label="Reporte del asistente">
      <div class="blockhead"><h2>Reporte del asistente</h2></div>
      <div class="panel connection">
        <form method="POST" action="/admin/configuracion/reporte-diario">
          <div class="field">
            <label for="reporte-telefono">WhatsApp que recibe el resumen</label>
            <input type="text" id="reporte-telefono" name="telefono" value="${escapeHtml(reportRecipient ?? "")}" placeholder="whatsapp:+573001234567">
            <p class="hint">A las 8:00 a. m. (hora Colombia) se manda un resumen de mensajes, clientes, conversaciones cerradas y pedidos. Dejar vacío para no recibirlo.</p>
          </div>
          <div class="field">
            <label id="frecuencia-label">Frecuencia</label>
            <div class="choicegrid" role="radiogroup" aria-labelledby="frecuencia-label" data-frecuencia-grid>
              ${choiceCard("frecuencia", "diario", reportFrequencyPreset, ICON_CALENDARIO, "Diario", "Todos los días.")}
              ${choiceCard("frecuencia", "semanal", reportFrequencyPreset, ICON_CALENDARIO, "Semanal", "Una vez por semana.")}
              ${choiceCard("frecuencia", "mensual", reportFrequencyPreset, ICON_CALENDARIO, "Mensual", "Una vez al mes.")}
              ${choiceCard("frecuencia", "personalizado", reportFrequencyPreset, ICON_PERSONALIZADO, "Personalizado", "Elegís cada cuántos días.")}
            </div>
          </div>
          <div class="field" data-dias-personalizados-wrap${reportFrequencyPreset === "personalizado" ? "" : ' style="display:none"'}>
            <label for="dias-personalizados">Cada cuántos días</label>
            <input type="number" id="dias-personalizados" name="diasPersonalizados" min="2" max="365" value="${reportFrequencyCustomValue}">
          </div>
          <div class="formfoot"><button type="submit" class="btn btn--primary">Guardar</button></div>
        </form>
      </div>
    </section>
    <section class="block block--narrow" aria-label="Encuestas y reseñas">
      <div class="blockhead"><h2>Encuestas y reseñas</h2></div>
      <div class="panel connection">
        <form method="POST" action="/admin/configuracion/resenas">
          <div class="field">
            <label for="review-link">Link para dejar una reseña</label>
            <input type="text" id="review-link" name="link" value="${escapeHtml(reviewLink ?? "")}" placeholder="https://g.page/r/.../review">
            <p class="hint">Al cerrar una conversación se le pregunta al cliente cómo calificaría su experiencia (1 al 5). Si responde con 4 o 5 y este link está configurado, se lo mandamos junto con el agradecimiento. Dejar vacío para no pedir reseña.</p>
          </div>
          <div class="formfoot"><button type="submit" class="btn btn--primary">Guardar</button></div>
        </form>
      </div>
    </section>
    <section class="block block--narrow" aria-label="Cobros en línea">
      <div class="blockhead"><h2>Cobros en línea</h2><span class="hint">BYOK — Wompi</span></div>
      <div class="panel connection">
        <form method="POST" action="/admin/configuracion/cobros">
          <div class="field">
            <label for="wompi-private-key">Llave privada</label>
            <input type="password" id="wompi-private-key" name="privateKey" autocomplete="off" placeholder="prv_test_... o prv_prod_...">
            <p class="hint">${
              maskedWompiKey
                ? `Ya hay una guardada: <span class="mono">${escapeHtml(maskedWompiKey)}</span>. Dejar el campo vacío para conservarla.`
                : "Sin configurar — el método de pago en línea no aparece como opción para los clientes."
            }</p>
          </div>
          <div class="field">
            <label for="wompi-events-secret">Secreto de eventos</label>
            <input type="password" id="wompi-events-secret" name="eventsSecret" autocomplete="off" placeholder="test_events_... o prod_events_...">
            <p class="hint">${
              maskedEventsSecret
                ? `Ya hay uno guardado: <span class="mono">${escapeHtml(maskedEventsSecret)}</span>. Dejar el campo vacío para conservarlo.`
                : "Necesario para confirmar los pagos automáticamente — está en el dashboard de Wompi, en Secretos de integración."
            }</p>
          </div>
          <div class="formfoot"><button type="submit" class="btn btn--primary">Probar y guardar</button></div>
        </form>
      </div>
    </section>
  `;

  return layout("Configuración", tenant, body, "configuracion", admin);
}

export async function pausarBot(): Promise<void> {
  await setBotPaused(true);
}

export async function reactivarBot(): Promise<void> {
  await setBotPaused(false);
}

/**
 * Tono/Estilo de mensajes (Fase 11.4 extendida, ver ADR-021) — a diferencia
 * de "Probar y guardar" del modelo de IA, acá no hay nada que validar
 * contra una API externa, se guarda directo.
 */
export async function guardarComportamiento(
  input: { tono: string; estiloMensajes: string; velocidadRespuesta: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isTono(input.tono)) {
    return { ok: false, error: "Tono no válido." };
  }
  if (!isEstiloMensajes(input.estiloMensajes)) {
    return { ok: false, error: "Estilo de mensajes no válido." };
  }
  if (!isVelocidadRespuesta(input.velocidadRespuesta)) {
    return { ok: false, error: "Velocidad de respuesta no válida." };
  }
  await saveBehaviorConfig({
    tono: input.tono,
    estiloMensajes: input.estiloMensajes,
    velocidadRespuesta: input.velocidadRespuesta,
  });
  return { ok: true };
}

// whatsapp:+<código de país><número>, sin espacios — mismo formato que
// exige la API de Twilio para from/to (ver src/gateway/sendMessage.ts).
const WHATSAPP_PHONE_RE = /^whatsapp:\+\d{6,15}$/;

// Prefijos de país para el campo de teléfono de Colaboradores/Perfil (Fase
// 13 v2): el usuario elige el país en un select y escribe solo el número
// local — el whatsapp:+<prefijo><número> se arma acá adentro, no se escribe
// a mano. Lista corta con los países más relevantes para el piloto (LatAm +
// España/EE.UU.), no pretende ser exhaustiva.
const PHONE_COUNTRY_CODES: { code: string; label: string }[] = [
  { code: "57", label: "Colombia (+57)" },
  { code: "1", label: "EE. UU. / Canadá (+1)" },
  { code: "52", label: "México (+52)" },
  { code: "54", label: "Argentina (+54)" },
  { code: "56", label: "Chile (+56)" },
  { code: "51", label: "Perú (+51)" },
  { code: "593", label: "Ecuador (+593)" },
  { code: "58", label: "Venezuela (+58)" },
  { code: "34", label: "España (+34)" },
];
const DEFAULT_PHONE_COUNTRY_CODE = "57";

function phoneCountryOptions(selectedCode: string): string {
  return PHONE_COUNTRY_CODES.map(
    (c) => `<option value="${c.code}" ${c.code === selectedCode ? "selected" : ""}>${escapeHtml(c.label)}</option>`,
  ).join("");
}

/**
 * Arma `whatsapp:+<prefijo><número>` a partir del selector de país + el
 * número suelto — `number` vacío da `null` (deja de tener teléfono
 * cargado). Los no-dígitos del número (espacios/guiones) se descartan acá,
 * no hace falta que el usuario los evite.
 */
function buildWhatsappPhone(prefix: string, rawNumber: string): string | null {
  const digits = rawNumber.replace(/\D/g, "");
  if (digits === "") {
    return null;
  }
  return `whatsapp:+${prefix}${digits}`;
}

/**
 * Para prefill del form de Perfil: separa un `whatsapp:+<dígitos>` ya
 * guardado en el prefijo de país conocido más largo que matchee (para no
 * confundir "1" con "593") + el resto como número local. Si no matchea
 * ningún prefijo conocido (número legado con otro código), cae a Colombia
 * con todos los dígitos en el campo de número — mejor esfuerzo, no rompe
 * nada: el usuario puede corregir el país y el número se reconstruye igual
 * al guardar.
 */
function splitWhatsappPhone(phone: string | null): { prefix: string; number: string } {
  if (!phone) {
    return { prefix: DEFAULT_PHONE_COUNTRY_CODE, number: "" };
  }
  const digits = phone.replace(/^whatsapp:\+/, "");
  const sortedCodes = [...PHONE_COUNTRY_CODES].sort((a, b) => b.code.length - a.code.length);
  const match = sortedCodes.find((c) => digits.startsWith(c.code));
  if (match) {
    return { prefix: match.code, number: digits.slice(match.code.length) };
  }
  return { prefix: DEFAULT_PHONE_COUNTRY_CODE, number: digits };
}

/**
 * Reporte diario (Fase 12.2, ver ADR-018) — a diferencia de "Probar y
 * guardar" del modelo de IA, acá no hay nada que validar contra una API
 * externa, solo el formato del teléfono. Vacío limpia el campo (deja de
 * recibir reporte, ver src/jobs/dailyReport.ts).
 */
// Diario/semanal/mensual son atajos con un número de días fijo — el valor
// real que se guarda (report_frequency_days) es siempre un entero, ver
// migrations/0038_settings_reporte_frecuencia.cjs.
const REPORT_FREQUENCY_PRESET_DAYS: Record<string, number> = { diario: 1, semanal: 7, mensual: 30 };

export async function guardarReporteDiario(
  input: { telefono: string; frecuencia: string; diasPersonalizados: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = input.telefono.trim();
  if (trimmed !== "" && !WHATSAPP_PHONE_RE.test(trimmed)) {
    return { ok: false, error: 'Formato inválido. Usá "whatsapp:+" seguido del número, ej. whatsapp:+573001234567.' };
  }

  let frequencyDays: number;
  if (input.frecuencia === "personalizado") {
    const parsed = Number.parseInt(input.diasPersonalizados, 10);
    if (!Number.isInteger(parsed) || parsed < 2 || parsed > 365) {
      return { ok: false, error: "La frecuencia personalizada debe ser un número entre 2 y 365 días." };
    }
    frequencyDays = parsed;
  } else if (input.frecuencia in REPORT_FREQUENCY_PRESET_DAYS) {
    frequencyDays = REPORT_FREQUENCY_PRESET_DAYS[input.frecuencia]!;
  } else {
    return { ok: false, error: "Frecuencia no válida." };
  }

  await saveReportRecipient(trimmed === "" ? null : trimmed);
  await saveReportFrequencyDays(frequencyDays);
  return { ok: true };
}

/**
 * Link de reseña (Fase 12.2, ver satisfactionSurvey.ts) — sin validación
 * de formato más allá de "no vacío": puede ser cualquier URL corta que el
 * dueño del negocio use (Google Business, Facebook, etc.), no vale la
 * pena una lista cerrada de dominios permitidos.
 */
export async function guardarReviewLink(
  input: { link: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = input.link.trim();
  await saveReviewLink(trimmed === "" ? null : trimmed);
  return { ok: true };
}

/**
 * "Probar y guardar" (ver renderConfiguracionPage): prueba la combinación
 * ANTES de persistir — solo guarda si testLlmConfig no lanza. `provider`
 * vacío es "Automático" (vuelve al default de plataforma, sin llamada de
 * prueba porque es el mismo código que ya corría antes de la Fase 11.4).
 */
export async function guardarModeloIa(
  input: { provider: string; model: string; apiKey: string; routingMode: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (input.provider === "") {
    await clearLlmConfig();
    return { ok: true };
  }

  if (!isProviderKey(input.provider)) {
    return { ok: false, error: "Proveedor no válido." };
  }
  // "Cerebro del bot" (ADR-023): en automático el modelo puntual no
  // importa (se elige por turno según dificultad) — se guarda el default
  // del proveedor solo para no dejar el campo vacío, y "Probar y guardar"
  // prueba con ese default (representativo del proveedor, no
  // necesariamente el que se use en cada turno real).
  const routingMode = isLlmRoutingMode(input.routingMode) ? input.routingMode : "manual";
  const entry = PROVIDER_CATALOG[input.provider];
  const model =
    routingMode === "auto_dificultad"
      ? entry.defaultModel
      : entry.models.some((m) => m.id === input.model)
        ? input.model
        : entry.defaultModel;

  const existing = await getLlmConfig();
  const trimmedKey = input.apiKey.trim();
  // Campo vacío: si el proveedor no cambió, se conserva la key ya guardada
  // (el <input type="password"> nunca se re-popula con el valor
  // desencriptado — ver el "Ya hay una guardada: ••••" de solo lectura). Si
  // cambió de proveedor, la key vieja no sirve para el nuevo, así que se
  // limpia y se prueba con la key de sistema de ese proveedor si existe.
  const apiKey = trimmedKey ? trimmedKey : existing.provider === input.provider ? existing.apiKey : null;

  try {
    await testLlmConfig({ provider: input.provider, model, apiKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido probando la conexión.";
    return { ok: false, error: message };
  }

  await saveLlmConfig({ provider: input.provider, model, apiKey, routingMode });
  return { ok: true };
}

/**
 * Cobros en línea (Fase 12.4, ver ADR-024) — mismo criterio de "Probar y
 * guardar" que el Modelo de IA: se crea un link de pago real por
 * MIN_AMOUNT_COP (el mínimo real de Wompi para la base de una transacción,
 * descubierto en QA contra el sandbox — un monto menor a ese siempre
 * devuelve 422) para validar que la llave privada funciona ANTES de
 * persistirla. El secreto de eventos no se puede probar así (solo sirve
 * para verificar webhooks entrantes, ver wompiSignature.ts) — se guarda
 * sin test, igual que otros secretos de solo-verificación de este panel.
 * Campo vacío conserva el valor ya guardado (mismo patrón que la API key
 * de LLM: el <input type="password"> nunca se re-popula con el valor
 * desencriptado).
 */
export async function guardarCobros(
  input: { privateKey: string; eventsSecret: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const existing = await getWompiConfig();
  const privateKey = input.privateKey.trim() || existing.privateKey;
  const eventsSecret = input.eventsSecret.trim() || existing.eventsSecret;

  if (!privateKey || !eventsSecret) {
    return { ok: false, error: "Hace falta la llave privada y el secreto de eventos de Wompi." };
  }

  try {
    await createPaymentLink(privateKey, "Prueba de conexión ForMotos", MIN_AMOUNT_COP);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Error desconocido probando la conexión con Wompi.";
    return { ok: false, error: message };
  }

  await saveWompiConfig({ privateKey, eventsSecret });
  return { ok: true };
}
