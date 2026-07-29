# ADR-020: Proveedor y modelo de LLM configurable por tenant, con BYOK

## Estado
Aceptado.

## Contexto
[ADR-008](../../fase-4-motor-agente/adrs/ADR-008-modelo-claude.md) fijó Claude Sonnet 5 como la decisión de producción; [ADR-010](../../fase-4-motor-agente/adrs/ADR-010-abstraccion-proveedor-llm.md) introdujo el contrato neutro `LLMProvider` para poder probar con un proveedor barato (DeepSeek) sin comprometer esa decisión, seleccionable solo por variable de entorno a nivel de todo el proceso — un único proveedor/modelo para todos los tenants.

Al diseñar la Fase 11.4 (Configuración), el usuario pidió explícitamente que el proveedor y el modelo de LLM sean elegibles **por tenant** desde el panel, tomando como referencia la sección "Modelo de IA" de `/admin/config` del panel Forja: un selector de Proveedor + Modelo, un campo opcional de API key propia (BYOK), y un botón "Probar y guardar" que valida antes de persistir. Esto autoriza explícitamente relajar la restricción implícita de ADR-008 ("Claude Sonnet 5 es la decisión de producción") — sin revertirla: pasa a ser el default recomendado de la plataforma, no la única opción posible.

Se acordaron 3 decisiones de alcance con el usuario antes de implementar:
1. Agregar Gemini como tercera integración nativa (Anthropic ya existe; `OpenAICompatibleProvider` ya cubre DeepSeek/OpenAI/Grok gratis, mismo formato de chat completions — ver ADR-010).
2. Incluir BYOK desde ya (el tenant puede traer su propia API key, cifrada en Postgres) en vez de dejarlo para una fase posterior.
3. No incluir ruteo automático por dificultad del mensaje — solo selección explícita. "Automático" en el panel significa únicamente "usar el default de la plataforma" (lo que ya define `LLM_PROVIDER`/`LLM_MODEL` en `.env` hoy), sin lógica de enrutamiento dinámico por costo/complejidad.

## Opciones consideradas

**Alcance del catálogo de proveedores**
- Solo exponer los proveedores que ya existían de hecho (Anthropic + lo que `OpenAICompatibleProvider` ya cubre): más simple, pero deja fuera Gemini, cuyo formato de API (`generateContent`) es genuinamente distinto al de chat completions y el usuario lo pidió explícito.
- Agregar Gemini como integración nueva: única opción que cumple el pedido; el costo real es acotado porque los otros 3 proveedores (`deepseek`/`openai`/`xai`) no requieren código nuevo, solo entradas de catálogo con `baseUrl` distinto — ya comparten la implementación `family: "openai_compatible"`.

**Almacenamiento de la API key propia (BYOK)**
- No guardarla, pedirla en cada request: descartado, rompe la idea de "guardar la configuración una vez".
- Guardarla en texto plano en `tenants`: descartado sin discusión — es una credencial de terceros que la plataforma custodia en nombre del tenant.
- Cifrarla en reposo con AES-256-GCM, clave maestra en una env var nueva (`TENANT_SECRETS_ENCRYPTION_KEY`, con el mismo criterio de manejo que las demás credenciales de [ADR-007](../../fase-2-fundaciones/adrs/ADR-007-gestion-secretos.md)): elegida por dar autenticación además de confidencialidad — GCM detecta si el valor cifrado fue alterado (tag de autenticación), no solo lo protege de lectura directa en un dump de la base.

**Ruteo automático por dificultad/costo del mensaje**
- Enrutamiento dinámico (clasificar el mensaje y elegir el modelo más barato que alcance): descartado explícitamente por el usuario — agrega una capa de lógica y de costo de clasificación que no se justifica para el volumen actual del piloto, y complica la trazabilidad de "qué modelo respondió esto" en Tickets/Analítica.
- Selección explícita únicamente, con "Automático" como sinónimo de "el default de plataforma vigente" (no de "el mejor modelo para este mensaje"): opción elegida, mantiene el comportamiento de ADR-010 intacto como caso por defecto.

## Decisión

### Catálogo de proveedores
`src/orchestrator/llm/catalog.ts` — un único `PROVIDER_CATALOG` declarativo (`anthropic`/`deepseek`/`openai`/`xai`/`gemini`), cada entrada con `label`, `family` (`"anthropic" | "openai_compatible" | "gemini"` — determina qué clase de `LLMProvider` instanciar), `baseUrl` (solo aplica a `openai_compatible`), `defaultModel`, `models[]` y `keyPlaceholder` (para el campo BYOK del panel). Puramente de datos — agregar un modelo nuevo de un proveedor ya soportado es agregar una entrada al arreglo, no tocar lógica.

### Esquema (migración `0020_tenants_llm_config_bot_paused.cjs`)
```sql
ALTER TABLE tenants ADD COLUMN llm_provider text; -- NULL = usar el default de plataforma (env.LLM_PROVIDER)
ALTER TABLE tenants ADD COLUMN llm_model text;    -- NULL = usar el default de ese proveedor en el catálogo
ALTER TABLE tenants ADD COLUMN llm_api_key_encrypted text; -- NULL = usar la key de sistema del proveedor, si existe
```
(`bot_paused` va en la misma migración — ver [configuracion-comportamiento.md](../configuracion-comportamiento.md), es la otra mitad de esta fase.)

### Cifrado (`src/shared/crypto/secretBox.ts`)
AES-256-GCM con `node:crypto`. IV de 12 bytes por valor (recomendación NIST SP 800-38D para GCM), guardado como `iv_hex:authTag_hex:ciphertext_hex`. La clave maestra (`TENANT_SECRETS_ENCRYPTION_KEY`, 32 bytes en base64) es un secreto de plataforma en el sentido de ADR-007 (vive en Fly Secrets/`.env`, nunca en el repo) — lo que cifra (la API key que trae el tenant) es una categoría de secreto distinta, que ADR-007 no cubre porque en ese momento no existía BYOK.

`getLlmConfig(tenantId)` es la única función que lee `llm_api_key_encrypted` y la desencripta (`src/shared/db/tenantsDirectory.ts`) — deliberadamente separada de `getTenant()`/`TenantSummary`, que se usa en cada carga de página del panel para branding/nav, para que la key cifrada no viaje "de paso" en requests que no la necesitan.

### Resolución por turno (`src/orchestrator/llm/index.ts`)
`resolveLlmProviderForTenant(tenantId)` reemplaza el singleton `llmProvider` que exportaba este módulo antes de esta fase:
1. Lee la config del tenant (`getLlmConfig`).
2. Sin override (`llm_provider IS NULL`, "Automático") → arma el proveedor/modelo default de `env` — comportamiento idéntico al de antes de esta fase, cero regresión para tenants sin configurar nada.
3. Con override → busca la entrada del catálogo, resuelve la API key efectiva (la del tenant si trajo una, si no la key de sistema — que solo existe de verdad para el proveedor que ya es hoy el default de plataforma; para cualquier otro, `null`) y construye el `LLMProvider` de la `family` correspondiente. Si no hay ninguna key disponible, lanza un error explícito — este estado no debería alcanzarse porque el panel ya valida con una llamada de prueba antes de guardar (ver más abajo), así que si ocurre en producción es una falla real que debe verse, no un fallback silencioso.

`AnthropicProvider`/`OpenAICompatibleProvider` ganaron un constructor `{ apiKey?, model?, baseUrl? }` que sobreescribe el default de `env` solo si se pasa — sin esto, `resolveLlmProviderForTenant` no podría instanciar un proveedor con la key/modelo del tenant. `GeminiProvider` (nuevo, `src/orchestrator/llm/geminiProvider.ts`) nace ya con ese constructor; traduce contra `generateContent` (no chat completions) — incluye generar un id sintético (`randomUUID()`) para cada `functionCall`, porque a diferencia de Anthropic/OpenAI, Gemini no manda id en sus llamadas a tools, solo el nombre.

`loop.ts` llama a `resolveLlmProviderForTenant(tenantId)` una vez al inicio de `runTurn` — el resto del loop (guardrails de precio/stock, tool calling) sigue operando sobre el contrato neutro `ContentBlock`/`LLMMessage` sin cambios.

### Kill-switch (`bot_paused`)
Chequeo en `src/orchestrator/consumer.ts`, antes de invocar `runTurn` — evita resolver un proveedor de LLM (y su costo, si aplica) para un tenant pausado. El mensaje del cliente se guarda igual (mismo par `resolveConversation`/`appendMessage` que usa `runTurn` al empezar), para no perder historial mientras el bot está pausado.

### Panel — `GET /admin/:tenantId/configuracion`
Dos bloques independientes:
- **Estado del bot**: activo/pausado, con confirmación explícita solo al pausar (afecta clientes reales).
- **Modelo de IA**: selector de Proveedor (incluye "Automático") + selector de Modelo (filtrado en JS vanilla según el proveedor elegido) + campo de API key propia opcional (`type="password"`, nunca se re-popula con el valor desencriptado — se muestra un `••••` + últimos 4 caracteres de solo lectura si ya hay una guardada) + botón "Probar y guardar". El POST (`/admin/:tenantId/configuracion/modelo-ia`) llama a `testLlmConfig()` (arma el mismo `LLMProvider` que armaría `resolveLlmProviderForTenant`, con los valores todavía no guardados, y hace una llamada real trivial) **antes** de persistir — si falla, se muestra el error y no se guarda nada. Es la única defensa real contra guardar una combinación que no va a funcionar en producción.

## Consecuencias
- ADR-008 no se revierte: Claude Sonnet 5 sigue siendo el default recomendado de la plataforma — esta ADR solo agrega la posibilidad de que un tenant lo cambie explícitamente. ADR-010 tampoco se revierte: su contrato `LLMProvider` es exactamente lo que hizo posible esta fase sin reescribir el loop.
- Gemini nunca es el default de plataforma (no participa de la resolución de key de sistema) — un tenant que lo elige sin traer su propia key ve el error de "Probar y guardar" en el momento de intentar guardarlo, nunca en producción con un cliente real esperando respuesta.
- El campo `model` que faltaba en el log `orchestrator.llm_completado` para [ADR-017](./ADR-017-persistencia-uso-llm-postgres.md) (Fase 11.5, Analítica) ahora está disponible gratis en el valor de retorno de `resolveLlmProviderForTenant` — esa fase ya no necesita inferirlo de `env` a mano.
- El tono/estilo/velocidad de redacción del agente sigue fuera de alcance (ver [configuracion-comportamiento.md](../configuracion-comportamiento.md)) — es un eje distinto (qué dice el prompt) del que resuelve esta ADR (qué modelo procesa el prompt), y sigue bloqueado por la necesidad de mantener el `system` prompt byte-idéntico para el prompt caching de Claude.
- Un tenant que cambia de proveedor y no vuelve a poner su BYOK pierde acceso a la key vieja (no se reutiliza entre proveedores distintos) — es el comportamiento esperado, una key de OpenAI no sirve para Gemini.
