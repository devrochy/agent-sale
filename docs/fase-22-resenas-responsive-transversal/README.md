# Fase 22 — Reseñas, Redes Sociales y Cierre Responsive Transversal

Estado: **en diseño** (v2)

Referencia: [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md#fase-22--reseñas-redes-sociales-y-cierre-responsive-transversal) · [PROPUESTA_V2.md §3.12, §3.13](../../PROPUESTA_V2.md) · [Fase 11 — pendiente de rediseño responsive](../fase-11-panel-admin-dashboard/README.md#pendiente-rediseño-responsive-del-contenido) · `src/reviews/reviewView.ts`

Última fase de v2: unifica visualmente `reviewView.ts` con el resto del panel, evalúa (sin comprometer implementación) integración con Google My Business, y cierra definitivamente el rediseño responsive de contenido que quedó pendiente desde el cierre de la Fase 11 — ahora extendido a todas las pantallas nuevas de v2 (Fases 13, 14, 17, 18).

## Relación con v1

- **Extiende** `src/reviews/reviewView.ts` (Fase 12.2) — cambio de estilo, sin tocar la lógica de generación de reseñas ni de tokens (`review_tokens`, `migrations/0029`).
- **Retoma explícitamente** el pendiente documentado en `docs/fase-11-panel-admin-dashboard/README.md#pendiente-rediseño-responsive-del-contenido`: *"lo que queda pendiente es que el contenido de cada sección... se rediseñe para pantallas angostas"*. No es un ítem nuevo de v2 — es deuda de v1 que esta fase cierra, ahora con un inventario de pantallas más grande (todo lo construido en 13-21).
- No choca con ninguna ADR — es la única fase de v2 puramente de presentación, sin cambios de esquema ni de contrato de tools.

## Contenido de esta fase

Sin ADR propia — no hay una decisión de arquitectura nueva que registrar. El patrón "tabla → cards" para pantallas angostas ya está identificado en el README de Fase 11 como una decisión de diseño de UI a resolver una sola vez sobre el inventario completo de componentes compartidos (`STYLE_BLOCK`/`CLIENT_SCRIPT` de `src/admin/adminPanel.ts`) — esta fase ejecuta esa decisión, no la reabre.

## Dependencias

Las Fases 13, 14, 17 y 18 (paneles nuevos) deben existir para que el rediseño responsive cubra el inventario completo de pantallas de v2, no solo las de v1.

## Riesgos

- Diseñar el patrón responsive antes de que existan todas las pantallas nuevas obligaría a rehacerlo — por eso va al final.
- Si el negocio necesita el panel usable en celular antes de que 13-21 terminen, debe subir de prioridad, igual que ya advirtió el README de Fase 11 para el piloto original.

## Definición de terminado

- [ ] `reviewView.ts` visualmente consistente con el panel admin.
- [ ] Todas las tablas/inbox/formularios nuevos de v2 (13-21) se ven correctamente en una pantalla de celular real, sin scroll horizontal no intencional.
- [ ] Documento de evaluación de Google My Business entregado, sin compromiso de implementación.

Cierra la planificación de v2. Siguiente paso: ejecución de las fases 13-22 según el orden y paralelización recomendados en `MASTER_PLAN_V2.md`, y — cuando el negocio confirme que v2 está lista para producción — la fusión de `MASTER_PLAN.md`/`MASTER_PLAN_V2.md` y de los árboles `docs/fase-*` según el criterio de `PROPUESTA_V2.md` §5.
