# orchestrator

Loop manual de tool calling con un LLM: arma contexto, llama al proveedor configurado, ejecuta tools, persiste memoria conversacional (ver `docs/fase-4-motor-agente/orquestador.md`). Único módulo que conoce el flujo completo de una conversación.

- `consumer.ts` / `index.ts` — consumer group de Redis Streams sobre `whatsapp:inbound`.
- `loop.ts` — el loop manual de tool calling (`runTurn`), incluye manejo de `refusal`, límite de iteraciones y las reglas de escalamiento de `escalationRules.ts`.
- `memory.ts` — memoria conversacional (`conversations`/`messages`).
- `escalationRules.ts` — reglas explícitas de escalamiento (ver docs/fase-7-escalamiento-humano/reglas-escalamiento.md): palabras clave (queja/solicitud_cliente), monto alto, intentos fallidos. Configurables por tenant vía `tenants.escalation_config` (migrations/0014), con defaults si el tenant no configuró nada.
- `systemPrompt.ts`, `toolDefinitions.ts`, `toolExecutor.ts` — piezas del loop.
- `llm/` — abstracción de proveedor de LLM (ver ADR-010): `types.ts` define el contrato neutro, `anthropicProvider.ts` (Claude, default de producción, ADR-008) y `openaiCompatibleProvider.ts` (DeepSeek/Groq/OpenAI, para pruebas reales de bajo costo) lo implementan, `index.ts` elige uno según `LLM_PROVIDER`.

Tools implementadas: `consultar_inventario`, `escalar_a_humano` (Fase 4), `generar_cotizacion`, `aplicar_promocion`, `crear_pedido`, `recomendar_producto` (Fase 6, dominio comercial).

Una vez que `conversations.state.step === "escalado"`, el agente deja de responder automáticamente en esa conversación (ver reglas-escalamiento.md, "qué pasa después de escalar") — los mensajes siguientes se guardan pero no se reprocesan con el LLM. La vista del asesor (para tomar/cerrar el caso) es un incremento de código separado.
