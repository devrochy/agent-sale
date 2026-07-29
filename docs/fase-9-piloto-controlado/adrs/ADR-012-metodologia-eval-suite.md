# ADR-012: Metodología de la eval suite (golden set)

## Estado
Aceptado.

## Contexto
`MASTER_PLAN.md` pide una "eval suite (golden set de conversaciones) corriendo en CI/CD antes de cada deploy". Los tests existentes (`tests/unit/orchestrator/loop.test.ts`, etc.) mockean el LLM (`vi.mock('./llm/index.js')`) — verifican que el *código* reacciona bien a una respuesta dada del modelo, no que el *modelo real* se comporte como se espera frente a clientes reales. La eval suite cubre ese hueco: corre conversaciones completas contra el proveedor de LLM real configurado (Claude o DeepSeek, vía la abstracción de ADR-010).

## Opciones consideradas

1. **Solo assertions determinísticas** (¿se llamó la tool correcta? ¿el guardrail de precios se disparó cuando debía? ¿escaló con el motivo correcto?). Barato y confiable, pero no detecta regresiones de tono/calidad de respuesta (ej. el agente responde correctamente pero de forma cortante o confusa).
2. **LLM-as-judge**: un segundo modelo califica cada respuesta contra una rúbrica. Cubre lo que las assertions determinísticas no ven, pero agrega una dependencia nueva (el juez también puede equivocarse, es un problema conocido de esta técnica), costo de tokens duplicado, y complejidad de mantenimiento — no se justifica todavía al volumen de un golden set chico y un piloto de 1-2 tenants.
3. **Híbrido**: assertions determinísticas para todo lo que es correctness/seguridad (obligatorio, bloquea CI), más una revisión manual de tono/calidad sobre el mismo golden set (no bloqueante, es una lista de chequeo que revisa una persona cuando el golden set corre).

## Decisión
**Híbrido (opción 3).** Las assertions determinísticas cubren exactamente lo que ya identificamos como crítico en fases anteriores — guardrail de precios ([guardrails.md](../../fase-8-observabilidad-seguridad/guardrails.md)), aislamiento multi-tenant (RLS, Fase 2), idempotencia de pedidos (Fase 6), reglas de escalamiento (Fase 7) — y son las que bloquean el deploy si fallan. La revisión de tono queda como checklist manual sobre las mismas transcripciones del golden set, ejecutada por una persona en cada corrida relevante (no en cada PR) — mismo criterio que el resto del proyecto de no construir infraestructura para un problema que todavía no demostró necesitarla. Si el golden set crece lo suficiente como para que la revisión manual sea un cuello de botella, ahí se reevalúa LLM-as-judge.

## Consecuencias
- La eval suite corre conversaciones reales contra el proveedor de LLM configurado → **consume tokens reales y tiene costo** (bajo, dado el tamaño del golden set — ver [eval-suite.md](../eval-suite.md)). No corre en cada PR; corre antes de cada deploy a `develop`/`main` (ver integración en CI, `eval-suite.md`).
- Requiere que el golden set sea representativo pero chico (10-15 conversaciones) — un golden set grande vuelve inviable tanto el costo como la revisión manual de tono.
- Las assertions determinísticas necesitan que cada escenario declare de antemano qué tool debía llamarse y con qué shape de resultado — mismo patrón que ya usan los tests de integración existentes, pero orquestando `runTurn` completo en vez de mockear el LLM.
