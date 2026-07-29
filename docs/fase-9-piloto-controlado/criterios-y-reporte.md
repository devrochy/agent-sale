# Criterios de éxito y reporte del piloto

Cierra el tercer entregable de esta fase: "Reporte de resultados del piloto vs. criterios de éxito definidos en la Fase 0". Este documento define **cómo** se mide cada criterio con lo que ya existe — no inventa mecanismos nuevos, conecta [metricas-cierre-ventas.md](../fase-8-observabilidad-seguridad/metricas-cierre-ventas.md) (ADR-011) y el dashboard operacional (ADR-009) con la tabla original de la Fase 0.

## Mapeo de criterios (Fase 0 → mecanismo de medición)

| Métrica (Fase 0) | Objetivo | Cómo se mide | Dónde |
|---|---|---|---|
| % de mensajes resueltos sin humano | ≥ 60% | `1 - (escaladas / conversaciones_totales)` | Panel de negocio, [metricas-cierre-ventas.md](../fase-8-observabilidad-seguridad/metricas-cierre-ventas.md) |
| Tiempo de respuesta promedio | < 30 segundos | `total_latency_ms` (p50/p95, no solo promedio) | Dashboard operacional, [tracing.md](../fase-8-observabilidad-seguridad/tracing.md) (ADR-009) |
| Pedidos cerrados por semana | ≥ baseline manual (a medir en semana 1) | `con_pedido` por semana | Panel de negocio (ADR-011) |
| Rentabilidad del piloto | Costo operativo bajo frente al ticket promedio ($100.000 COP) | Costo total del período (tokens + Fly.io + BSP) / conversaciones atendidas | Dashboard operacional (costo/tokens) cruzado manualmente con conversaciones del panel de negocio — no hay panel único que una ambas fuentes todavía, ver "Qué no cubre esto" |

## Baseline

La Fase 0 dejó "pedidos cerrados por semana" con baseline **a medir en la semana 1 del piloto** (no había registro formal antes). La semana 1 de tráfico real no se compara contra el objetivo — se usa para fijar el baseline; recién de la semana 2 en adelante el reporte compara contra ese número.

## Reporte final

Al cierre del período de observación (parte de la estimación de 3-4 semanas de esta fase), el reporte debe incluir:

1. Los 4 criterios de la tabla de arriba, valor alcanzado vs. objetivo — **o el gap documentado**, si algo no se alcanzó (la definición de terminado de esta fase explícitamente permite un gap documentado, no exige 100%).
2. Resultado del ajuste del umbral de "monto alto" ([reglas-escalamiento.md](../fase-7-escalamiento-humano/reglas-escalamiento.md), pendiente de validar con datos reales desde la Fase 7) — quedó o no ajustado, y con qué valor.
3. Incidentes de seguridad o de negocio ocurridos durante el piloto (pedidos duplicados, fuga de datos entre tenants, precios erróneos) — la definición de terminado de esta fase exige **cero** de estos, a diferencia de las métricas de negocio de arriba, que sí toleran gap documentado.
4. Resultados del golden set ([eval-suite.md](./eval-suite.md)) corridos durante el período — si hubo alguna corrida con fallas que haya requerido intervención antes de un deploy.
5. Retroalimentación cualitativa del negocio piloto (ForMotos) sobre fricción de adopción — en particular sobre el panel admin de catálogo ([ADR-013](./adrs/ADR-013-mecanismo-catalogo-piloto.md)), que es un cambio de flujo de trabajo real para ellos.

## Qué no cubre esto

- Un panel único que cruce costo (Loki) con resultado de negocio (Postgres) automáticamente — hoy son dos datasources separados en Grafana (ver ADR-011); cruzarlos para el cálculo de rentabilidad es manual en este reporte. Si el piloto se extiende más allá de 1-2 tenants, vale la pena evaluar un panel que una ambas fuentes.
- Definir qué pasa si el piloto **no** alcanza los criterios de éxito — esa decisión (extender el piloto, ajustar el producto, o no avanzar a la Fase 10) es del negocio, no de este documento.
