# Fase 9 — Piloto Controlado (Beta con ForMotos)

Estado: **en diseño**

Referencia: [MASTER_PLAN.md](../../MASTER_PLAN.md#fase-9--piloto-controlado-beta-con-1-2-pymes) · [Fase 8 — Observabilidad, Seguridad y Guardrails](../fase-8-observabilidad-seguridad/README.md)

Documentación de diseño, mismo criterio que las fases anteriores. A diferencia de las Fases 1-8, que instrumentaron o construyeron capacidades nuevas sobre el sistema, esta fase valida el sistema completo con tráfico real — y para eso primero hay que **ejecutar** varias decisiones que las fases anteriores ya tomaron (ADRs aceptados) pero nunca se llevaron a una cuenta real.

## Contenido de esta fase

- [pendientes-pre-piloto.md](./pendientes-pre-piloto.md) — checklist de ejecución de lo que ya está decidido pero no está hecho: cuenta BSP real (Fase 3), hosting real en Fly.io (ADR-005), Postgres gestionado real en Supabase (ADR-006), proveedor de LLM de producción (ADR-008) y carga del catálogo real. Es la entrada de esta fase, no deuda de fases anteriores.
- [adrs/ADR-012-metodologia-eval-suite.md](./adrs/ADR-012-metodologia-eval-suite.md) — assertions determinísticas (bloquean CI) + revisión manual de tono (no LLM-as-judge, todavía no se justifica el costo/complejidad a este volumen).
- [eval-suite.md](./eval-suite.md) — el golden set concreto (11 escenarios: flujos de venta de la Fase 0 + los riesgos de esta fase — ambigüedad, groserías, manipulación/prompt injection) y su integración a CI/CD antes de cada deploy.
- [adrs/ADR-013-mecanismo-catalogo-piloto.md](./adrs/ADR-013-mecanismo-catalogo-piloto.md) — usa el panel admin ya construido (no el sync con Google Sheets diseñado en la Fase 5, que nunca se implementó) para cargar el catálogo real de ForMotos.
- [criterios-y-reporte.md](./criterios-y-reporte.md) — cómo se mide cada criterio de éxito de la Fase 0 con los mecanismos que ya existen (panel de negocio de ADR-011, dashboard operacional de ADR-009), y qué debe incluir el reporte final del piloto.
- [plan-maestro-pruebas.md](./plan-maestro-pruebas.md) — checklist manual (no automatizada, a diferencia del golden set) de todo el sistema contra sandbox: escenarios de punta a punta y verificación página por página del panel admin, jobs programados y Cobros con Wompi — la entrada práctica para validar antes de producción.

## Riesgos (de `MASTER_PLAN.md`)

- Comportamiento inesperado del agente con clientes reales (ambigüedad, groserías, intentos de manipulación/prompt injection) — cubierto por los escenarios 6-9 del golden set.
- Fricción de adopción del negocio piloto — riesgo concreto identificado en [ADR-013](./adrs/ADR-013-mecanismo-catalogo-piloto.md): ForMotos pasa de editar su Sheet a usar el panel admin. Debe validarse con el dueño del negocio antes de comprometer esa decisión, no asumirse.

## Definición de terminado

- [ ] Todos los ítems de [pendientes-pre-piloto.md](./pendientes-pre-piloto.md) resueltos (cuentas reales creadas y funcionando).
- [ ] Eval suite corriendo en CI/CD, gateando los deploys a `develop`/`main`.
- [ ] ForMotos operando en producción con tráfico real limitado, durante el período de observación.
- [ ] Reporte final entregado ([criterios-y-reporte.md](./criterios-y-reporte.md)): métricas de éxito de la Fase 0 alcanzadas o gap documentado.
- [ ] **Cero** incidentes críticos de seguridad o de negocio durante el piloto (pedidos duplicados, fuga de datos entre tenants, precios erróneos) — a diferencia de las métricas de negocio, este punto no admite gap documentado.

Siguiente paso (condicional a que el piloto se dé por exitoso): Fase 10 — Preparación para Escala.
