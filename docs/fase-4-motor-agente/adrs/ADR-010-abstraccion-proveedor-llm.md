# ADR-010: Abstracción de proveedor de LLM

## Estado
Aceptado.

## Contexto
Con el orquestador ya integrado contra Claude (ADR-008) y el incremento del motor del agente mergeado, la verificación manual end-to-end contra la API real quedó bloqueada: la cuenta de Anthropic no tiene crédito y el pago fue rechazado por la pasarela del banco. El resto del pipeline (gateway, cola, tool calling, retries/dead-letter) ya se validó funcionando correctamente contra la API real hasta el punto de la llamada al modelo — el bloqueo es puramente administrativo, no de código, pero impide seguir haciendo pruebas reales en las siguientes fases mientras se resuelve.

El proyecto necesita poder probar con un proveedor de bajo costo (o gratuito) sin comprometer la decisión de producción ya tomada (Claude Sonnet 5, ADR-008), y sin que cambiar de proveedor implique reescribir tools, memoria conversacional o el consumer.

## Opciones consideradas
- **No abstraer, esperar a resolver el pago con Anthropic**: más simple, pero deja todas las fases siguientes (dominio comercial, escalamiento, piloto) sin poder hacer una sola prueba real mientras dure el trámite bancario, con fecha de resolución incierta.
- **Reescribir todo el orquestador contra otro proveedor** (ej. migrar a OpenAI directamente): resuelve el bloqueo puntual pero descarta el trabajo de ADR-008 y obliga a repetir la migración si se quiere volver a Claude en producción.
- **Introducir un contrato neutro (`LLMProvider`) con implementaciones intercambiables**: mantiene Claude como decisión de producción, permite swap a un proveedor barato solo con variables de entorno, y el costo de mantenimiento es bajo porque el único punto que hablaba directamente con el SDK de Anthropic ya estaba aislado en `loop.ts`/`claudeClient.ts` desde el diseño original del orquestador.

## Decisión
Se introduce `src/orchestrator/llm/` con:
- `types.ts` — contrato neutro (`LLMProvider.converse`, tipos `ContentBlock`/`LLMMessage`/`ToolDefinition`/`TurnResponse`). El shape de los content blocks coincide a propósito con el de la API de Anthropic (ya persistido en `messages.tool_calls`), así que el proveedor Claude es casi un passthrough y toda la traducción real vive en el proveedor alternativo.
- `anthropicProvider.ts` — Claude Sonnet 5, thinking adaptativo y `effort: medium` (sin cambios de comportamiento respecto a ADR-008), proveedor por defecto.
- `openaiCompatibleProvider.ts` — implementación única, sin SDK adicional (usa `fetch` nativo), para cualquier API que hable el formato de chat completions de OpenAI: DeepSeek, Groq, el propio OpenAI, Together, Fireworks, etc. Traduce tools/mensajes/tool_calls al formato de OpenAI y el `finish_reason` de vuelta al contrato neutro.
- `index.ts` — selecciona el proveedor según `LLM_PROVIDER` (`anthropic` por defecto, `openai_compatible` para el resto).

Selección por entorno (`LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`) con defaults apuntando a DeepSeek — cambiar de proveedor para pruebas reales no toca código, solo `.env`.

**DeepSeek** se elige como proveedor de bajo costo recomendado para las pruebas reales inmediatas: API compatible con el formato de OpenAI (tool calling incluido), precio muy por debajo de Claude/OpenAI, y caching de contexto automático sin configuración adicional.

## Consecuencias
- Claude Sonnet 5 sigue siendo la decisión de producción (ADR-008 no se revierte) — este ADR solo agrega flexibilidad para pruebas y para el caso de que un proveedor no esté disponible temporalmente.
- El proveedor `openai_compatible` no replica features específicos de Anthropic sin equivalente directo (thinking adaptativo, prompt caching explícito vía `cache_control`) — para DeepSeek esto es aceptable porque su caching de contexto es automático; para otros proveedores de ese formato puede no serlo, pero no bloquea el tool calling ni el resto del loop.
- `stop_reason`/`finish_reason` de cada proveedor se normalizan a un conjunto reducido (`tool_use`/`end_turn`/`refusal`/`other`) — un proveedor futuro con semántica muy distinta (ej. modelos con function calling paralelo con reglas propias) podría necesitar ampliar este enum, pero no romper el contrato existente.
- Volver a Claude como único proveedor, si se decide en el futuro, es cambiar una variable de entorno, no revertir código.
