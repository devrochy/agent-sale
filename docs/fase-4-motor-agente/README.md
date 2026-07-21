# Fase 4 — Motor del Agente: Claude + Tool Calling + Memoria de Conversación

Estado: **completada** (rama `feature/fase-4-motor-agente`)

Referencia: [MASTER_PLAN.md](../../MASTER_PLAN.md#fase-4--motor-del-agente-claude--tool-calling--memoria-de-conversación) · [Fase 3 — WhatsApp Gateway](../fase-3-whatsapp-gateway/README.md)

Documentación de diseño, mismo criterio que las fases anteriores — sin código todavía.

## Contenido de esta fase

- [adrs/ADR-008-modelo-claude.md](./adrs/ADR-008-modelo-claude.md) — elección de **Claude Sonnet 5**, con estimación de costo real (~$12 USD/mes para el volumen de ForMotos).
- [adrs/ADR-010-abstraccion-proveedor-llm.md](./adrs/ADR-010-abstraccion-proveedor-llm.md) — contrato neutro (`LLMProvider`) que permite swap a un proveedor de bajo costo compatible con OpenAI (DeepSeek por defecto) sin tocar tools, memoria ni el consumer; Claude sigue siendo la decisión de producción.
- [orquestador.md](./orquestador.md) — diseño del loop manual de tool calling (no automático), con el flujo completo por turno de conversación.
- [prompt-caching.md](./prompt-caching.md) — qué se cachea (tools + system prompt), qué no (catálogo, historial), y cómo se verifica.
- [memoria-conversacional.md](./memoria-conversacional.md) — cómo se construye el array de mensajes por turno y qué guarda `conversations.state`.
- [auditoria.md](./auditoria.md) — qué se registra en `audit_log` por cada tool ejecutada y decisión de escalamiento.

## Definición de terminado

- [x] Orquestador diseñado: mensaje → contexto → Claude → tools → respuesta, con manejo de `tool_use`, `pause_turn` y `refusal`.
- [x] Modelo de Claude elegido y justificado con costo real (Sonnet 5, no Opus, no Haiku).
- [x] Estrategia de memoria conversacional definida (historial crudo + estado estructurado).
- [x] Estrategia de prompt caching definida, con riesgo de invalidadores silenciosos documentado.
- [x] Log de auditoría de decisiones del agente diseñado, con el principio "el LLM propone, la tool decide" aplicado también al log (se registra lo que la tool hizo, no lo que Claude propuso).

**Fase 4 completada.** Siguiente paso: Fase 5 — Dominio de Catálogo e Inventario en Tiempo Real.
