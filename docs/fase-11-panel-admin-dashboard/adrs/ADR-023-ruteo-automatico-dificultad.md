# ADR-023: Ruteo automático de modelo por dificultad ("Cerebro del bot")

## Estado

Aceptado. **Revierte el punto de [ADR-020](./ADR-020-proveedor-modelo-configurable-byok.md) sobre ruteo automático** — ver "Relación con ADR-020" abajo.

## Contexto

Al parametrizar la sección "Configuración" del panel de referencia Forja, quedaba pendiente el último control: **Cerebro del bot** (Económico/Equilibrado/Máximo — elige el modelo más barato o más potente según la dificultad del mensaje). ADR-020 había descartado esto explícitamente: "Enrutamiento dinámico... descartado explícitamente por el usuario — agrega una capa de lógica y de costo de clasificación que no se justifica para el volumen actual del piloto, y complica la trazabilidad de 'qué modelo respondió esto'".

El usuario pidió reabrir esa decisión explícitamente (confirmado vía pregunta directa, dado que la petición original de parametrizar "todo esto" incluía las 4 opciones de Forja, y "Cerebro del bot" era la única que chocaba con una decisión ya tomada). Esta ADR documenta esa reversión con trazabilidad, no la aplica en silencio.

## Opciones consideradas

- **Clasificador con una llamada extra a un LLM barato** (ej. Haiku clasifica "fácil/normal/difícil" antes de decidir el modelo real): descartado — agrega latencia y costo de clasificación a _cada_ mensaje, incluyendo los triviales que "económico" busca abaratar. El ahorro neto podría ser negativo.
- **Heurística local sobre señales baratas** (largo del mensaje, keywords, estado de la conversación), elegida: sin llamada extra, es el enfoque estándar de la industria para model cascading/routing por señales de bajo costo.
- **Heurística simétrica** (clasificar con la misma confianza entre los 3 niveles): descartada a favor de una heurística **asimétrica** — ver "Decisión".

## Decisión

### Columna: `tenants.llm_routing_mode`

Migración `0022_tenants_llm_routing_mode.cjs`: `text NOT NULL DEFAULT 'manual'` — flag de 2 valores (`'manual'` | `'auto_dificultad'`), no jsonb (mismo criterio que `bot_paused`, no `behavior_config`): tightly acoplado a `llm_provider`/`llm_model` (ADR-020), no un ajuste de comportamiento genérico. Requiere un `llm_provider` explícito elegido — "auto_dificultad" sin proveedor no tiene de dónde elegir tiers.

### Heurística asimétrica (`src/orchestrator/llm/difficultyRouting.ts`)

`classifyDifficulty(signal)`: default a **"equilibrado"**; solo sube a **"máximo"** ante señales de dificultad reales (`turnosSinResolver > 0` — ya hubo un turno sin resolver en esta conversación — o keywords de comparación/compatibilidad técnica: "compatible", "vs", "diferencia entre", "técnic..."); reserva **"económico"** solo para mensajes claramente triviales (cortos, sin señal de dificultad). Clasificar mal "fácil" como "equilibrado" cuesta centavos; clasificar mal "difícil" como "económico" es la regresión de calidad que esta feature debería evitar — se prefiere **errar caro, no barato**, ante señal ambigua.

`buildDifficultySignal` (en `loop.ts`) arma la señal desde el historial ya cargado — el texto de los mensajes de cliente en texto plano desde el final hacia atrás (bajo debounce, ver ADR-022, puede ser más de un mensaje) y `state.turnos_sin_resolver` ya persistido — no agrega ninguna consulta ni estado nuevo.

### Selección por índice (`pickModelByDifficulty`)

Elige del catálogo del proveedor ya configurado (`PROVIDER_CATALOG[provider].models[]`, ver `catalog.ts`) por índice: 0=económico, medio=equilibrado, último=máximo — los 4 catálogos existentes ya están ordenados así (las etiquetas ya dicen "rápido y barato"/"equilibrado"/"máxima inteligencia"). **Fallback explícito para catálogos con menos de 3 modelos**: con 1 modelo (`deepseek`) es un no-op, siempre ese modelo; con 2 (`xai`), "equilibrado" y "máximo" colapsan al índice 1.

### Bug real encontrado en QA: Haiku no soporta `thinking: adaptive`

Probando el tier "económico" contra la API real de Anthropic, `claude-haiku-4-5` rechazó la llamada: `"adaptive thinking is not supported on this model"`. `AnthropicProvider.converse()` seteaba `thinking`/`output_config.effort` incondicionalmente para _cualquier_ modelo — nunca se había notado porque antes de esta fase Sonnet 5 era el único modelo posible (ADR-008) y luego, con selección manual (ADR-020), nadie había probado Haiku en producción todavía. Corregido: `AnthropicProvider` detecta `model.includes("haiku")` y omite esos parámetros para ese caso — el tier "económico" de esta ADR es precisamente lo que hizo que este código path se ejecutara por primera vez.

### UI

En la sección "Modelo de IA" de Configuración: un selector "Selección de modelo" (Manual / Automático según dificultad) entre Proveedor y Modelo. En automático, el select de Modelo se deshabilita client-side (no aplica, se elige por turno) y el guardado usa el `defaultModel` del proveedor solo para la llamada de prueba de "Probar y guardar" (representativo, no necesariamente el que se use en cada turno real).

## Relación con ADR-020

**No se revierte todo ADR-020** — el catálogo, BYOK, cifrado y la resolución de "Automático = default de plataforma" siguen exactamente igual. Lo que se revierte es puntualmente la frase "Enrutamiento dinámico... descartado explícitamente" de su sección "Opciones consideradas". ADR-020 gana una nota corta al inicio apuntando acá — excepción deliberada a la convención del repo de no editar ADRs viejas (confirmado que no existía ningún patrón de "Supersedida por" hasta ahora, solo prosa cruzada en ADRs nuevas): acá se está revirtiendo un punto puntual, no solo extendiendo, y sin el puntero alguien que lea ADR-020 de cero nunca se enteraría de que ese punto cambió.

## Consecuencias

- Verificado en producción contra Anthropic real: un mensaje trivial ("Hola") clasificó "económico" → `claude-haiku-4-5`; un mensaje con keyword de compatibilidad clasificó "máximo" → `claude-opus-5`. Ambas llamadas completaron con éxito (incluye la corrección del bug de `thinking`).
- `orchestrator.llm_iniciado`/`orchestrator.llm_completado` ganan los campos `model`/`dificultad` en el log — necesarios para poder verificar en producción qué tier se usó por turno (antes de esta ADR, el modelo resuelto no se logueaba en absoluto).
- Un tenant en modo automático con un proveedor de 1 solo modelo (DeepSeek) no gana nada de esta feature — es un no-op transparente, no un error.
- La heurística es deliberadamente simple (keywords + largo + estado) — no es un clasificador de ML. Si en producción se observan clasificaciones sistemáticamente malas, es una iteración futura sobre este mismo archivo, no un rediseño de la arquitectura.
