# orchestrator

Loop manual de tool calling con un LLM: arma contexto, llama al proveedor configurado, ejecuta tools, persiste memoria conversacional (ver `docs/fase-4-motor-agente/orquestador.md`). Único módulo que conoce el flujo completo de una conversación.

- `consumer.ts` / `index.ts` — consumer group de Redis Streams sobre `whatsapp:inbound`.
- `loop.ts` — el loop manual de tool calling (`runTurn`), incluye manejo de `refusal` y límite de iteraciones.
- `memory.ts` — memoria conversacional (`conversations`/`messages`).
- `systemPrompt.ts`, `toolDefinitions.ts`, `toolExecutor.ts` — piezas del loop.
- `llm/` — abstracción de proveedor de LLM (ver ADR-010): `types.ts` define el contrato neutro, `anthropicProvider.ts` (Claude, default de producción, ADR-008) y `openaiCompatibleProvider.ts` (DeepSeek/Groq/OpenAI, para pruebas reales de bajo costo) lo implementan, `index.ts` elige uno según `LLM_PROVIDER`.

Tools implementadas hasta ahora: `consultar_inventario`, `escalar_a_humano`. El resto (`generar_cotizacion`, `aplicar_promocion`, `crear_pedido`, `recomendar_producto`) llega con el dominio comercial (Fase 6).
