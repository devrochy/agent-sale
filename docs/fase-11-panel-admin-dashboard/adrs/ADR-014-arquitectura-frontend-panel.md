# ADR-014: Arquitectura frontend del panel admin

## Estado
Aceptado.

## Contexto
El panel admin actual (`src/admin/adminPanel.ts`) es HTML server-rendered puro: template strings, sin ningún paquete de frontend en `package.json`, sin carpeta `public/`, sin bundler. El comentario del propio archivo (`adminPanel.ts:1-9`) deja explícito que es un panel interno mínimo, no un producto de cliente final.

La Fase 11 agrega superficie real de interactividad que el patrón actual no cubre bien: tabs de bandeja (Conversaciones filtradas por estado), expandir/colapsar resúmenes de leads, un inbox con lista+detalle, un diagrama de flujo del agente. Nada de esto requiere edición compleja del lado cliente (no hay drag&drop, no hay formularios con validación reactiva pesada) — es navegación e interacciones puntuales sobre datos que el servidor ya sabe renderizar.

## Opciones consideradas

1. **React SPA + capa de API JSON nueva.** Da la mayor flexibilidad de interacción a futuro, pero exige introducir un bundler, una carpeta de assets, un pipeline de build, y — más significativo — una API JSON que hoy no existe en absoluto (todo el proyecto responde HTML). Se duplicaría el trabajo de serialización (HTML para lo que ya hay, JSON para lo nuevo) sin que haya ningún consumidor de esa API fuera del propio panel.
2. **HTML server-rendered enriquecido con htmx/Alpine.js vía CDN.** htmx permite que tabs, filtros y expandibles hagan requests que devuelven **fragmentos HTML** (no JSON) y los intercambian en el DOM; Alpine.js cubre micro-interacciones puramente cliente (abrir/cerrar un detalle) sin request. Ninguno de los dos aparece en `package.json` — se cargan por `<script src="https://unpkg.com/...">`, igual de "sin dependencia de build" que el resto del proyecto.
3. **Mantener template strings puras, sin ninguna librería cliente.** Suficiente para las páginas de solo lectura de hoy, pero obliga a implementar tabs/filtros como recargas de página completas — aceptable para Catálogo/Pedidos, degradado para un inbox de Conversaciones que se espera fluido.

## Decisión
**Opción 2: HTML server-rendered + htmx/Alpine.js vía CDN.**

Razones:
- Coherente con el criterio de minimalismo ya usado en otras decisiones del proyecto (Redis Streams en vez de Kafka, sin vault de secretos, sin login completo en la vista de asesor — ver [vista-asesor.md](../../fase-7-escalamiento-humano/vista-asesor.md)): no se introduce infraestructura nueva para un problema que el patrón actual, ligeramente extendido, ya resuelve.
- Evita el problema de "dos contratos": con htmx el servidor sigue siendo la única fuente de verdad de renderizado (HTML), no hace falta mantener endpoints JSON en paralelo a las páginas HTML existentes.
- Los gráficos que necesita el panel (barras de actividad, tendencia de costo) son simples series de una sola dimensión — se generan como SVG interpolado en el servidor, mismo patrón que ya usa `formatCOP()` en `adminPanel.ts:40-42`, sin agregar una librería de charting.
- El equipo que mantiene el proyecto ya conoce el patrón `layout()` + queries + `escapeHtml()` de `adminPanel.ts`/`handoffView.ts`; extenderlo tiene menor curva que introducir React.

## Consecuencias
- Todas las páginas nuevas de la Fase 11 (11.1-11.5) siguen extendiendo `src/admin/adminPanel.ts` (o módulos nuevos bajo `src/admin/`), no un directorio de frontend separado.
- Las interacciones que devuelven fragmentos (ej. cambiar de tab en Conversaciones) se sirven como rutas Fastify adicionales que retornan solo el fragmento HTML relevante, marcadas con `hx-get`/`hx-target` en el HTML padre.
- Si en el futuro el panel necesita interacción cliente compleja (edición inline con validación reactiva, drag&drop), esta decisión se revisita — mismo patrón de "disparador de revisión" que otras ADRs del proyecto usan para diferir complejidad no justificada hoy.
- No se agrega ninguna dependencia nueva a `package.json`; htmx/Alpine.js se referencian por CDN en el `<head>` del `layout()`.
