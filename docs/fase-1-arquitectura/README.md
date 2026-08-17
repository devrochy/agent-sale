# Fase 1 — Arquitectura Técnica y Diseño de Datos

Estado: **completada** (rama `feature/fase-1-arquitectura`)

Referencia: [MASTER_PLAN.md](../../MASTER_PLAN.md#fase-1--arquitectura-técnica-y-diseño-de-datos) · [Fase 0 — Descubrimiento](../fase-0-descubrimiento.md)

## Contenido de esta fase

- [arquitectura.md](./arquitectura.md) — diagrama de contenedores/componentes y descripción de cada pieza.
- [modelo-datos.md](./modelo-datos.md) — modelo entidad-relación de Postgres.
- [contratos-tools.md](./contratos-tools.md) — schemas de entrada/salida de las tools que usará Claude.
- [adrs/](./adrs) — Architecture Decision Records de las decisiones clave.

## Definición de terminado

- [x] Documento de arquitectura con diagramas de contenedores y flujo de mensaje.
- [x] Modelo de datos validado contra los casos de uso de la Fase 0 (ForMotos) — incluye estructura de promociones por temporada/volumen y fuente de inventario intercambiable (Google Sheets hoy).
- [x] Contratos de tools definidos (`consultar_inventario`, `generar_cotizacion`, `aplicar_promocion`, `crear_pedido`, `recomendar_producto`, `escalar_a_humano`).
- [x] ADRs de BSP, broker de colas, caché y multi-tenancy documentados.
- [x] Revisión y aprobación humana del documento (PR #2 mergeado).
- [x] ADR-001 (BSP) actualizado con estimación de costo real para el volumen de ForMotos: se decide empezar con **Twilio** (más barato a bajo volumen), con umbral documentado (~10.000 mensajes/mes) para reevaluar migración a 360dialog.

**Nota:** las cifras del ADR-001 vienen de fuentes públicas de mercado, no de una cotización oficial. Antes de crear la cuenta real en la Fase 3, se debe confirmar la tarifa exacta directamente con Twilio.

**Fase 1 completada, sin pendientes que bloqueen la Fase 2.** Siguiente paso: Fase 2 — Fundaciones de Plataforma.
