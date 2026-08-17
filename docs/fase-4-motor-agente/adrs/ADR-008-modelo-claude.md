# ADR-008: Selección del modelo Claude

## Estado
Aceptado.

## Contexto
El agente necesita: mantener una conversación de venta coherente, decidir cuándo llamar tools (inventario, cotización, promociones, escalamiento), y hacerlo con calidad suficiente para no cotizar mal ni prometer algo fuera de catálogo — todo esto al costo más bajo posible, dado el requisito explícito de "bajo costo" del proyecto.

## Opciones consideradas (pricing vigente, julio 2026)

| Modelo | Precio input/output (por MTok) | Fortalezas | Para este caso |
|---|---|---|---|
| **Claude Opus 4.8** | $5 / $25 | Máxima calidad, mejor para razonamiento largo y trabajo agéntico complejo | Sobredimensionado para responder preguntas de producto y armar cotizaciones — el costo no se justifica frente a la complejidad real de la tarea |
| **Claude Sonnet 5** | $3 / $15 (**$2 / $10 introductorio hasta 2026-08-31**) | Calidad cercana a Opus en tareas de codificación/agénticas, a costo Sonnet; thinking adaptativo; soporta niveles de esfuerzo `low`→`max` | Punto óptimo: suficiente calidad para tool calling confiable + conversación natural, a una fracción del costo de Opus |
| **Claude Haiku 4.5** | $1 / $5 | El más barato y rápido | Riesgo de calidad insuficiente para decidir correctamente cuándo escalar, cómo combinar promociones, o mantener contexto en conversaciones de varios turnos — no se justifica el ahorro frente al riesgo de negocio (cotizar mal, prometer algo incorrecto) |

## Decisión
**Claude Sonnet 5** (`claude-sonnet-5`), con **thinking adaptativo** (`{type: "adaptive"}`) y **`effort: "medium"`** por defecto — suficiente para tool calling confiable en una conversación de venta sin gastar de más en razonamiento que la tarea no requiere. Se aprovecha además el precio introductorio ($2/$10 por MTok) vigente hasta el 31 de agosto de 2026.

No se usa Haiku 4.5 para el flujo principal de conversación por el riesgo de negocio de una decisión equivocada (ej. no reconocer que debe escalar, o combinar mal una promoción) — pero queda como opción a evaluar en el futuro para sub-tareas simples y aisladas (ej. clasificar si un mensaje es una queja antes de que el agente principal responda), no como reemplazo del modelo principal.

## Estimación de costo mensual (ForMotos, ~430 conversaciones/mes)

**Supuestos:**
- ~6 llamadas a la API de Claude por conversación (una por turno relevante).
- Prompt caching activo (ver [prompt-caching.md](../prompt-caching.md)): ~1.500 tokens de contexto cacheado (system prompt + definiciones de tools) por llamada, ~500 tokens de contenido no cacheado (mensaje nuevo + historial reciente).
- ~300 tokens de salida por respuesta.
- Se usa el precio introductorio de Sonnet 5 ($2/$10 por MTok).

| Concepto | Cálculo | Costo mensual (USD) |
|---|---|---|
| Salida | 2.580 llamadas × 300 tokens × $10/1M | ~$7,74 |
| Entrada no cacheada | 2.580 × 500 tokens × $2/1M | ~$2,58 |
| Entrada cacheada (lectura, ~0,1×) | 2.580 × 1.500 tokens × $0,20/1M | ~$0,77 |
| Escrituras de caché (estimado, ~200/mes) | 200 × 2.000 tokens × $2,50/1M | ~$1,00 |
| **Total estimado** | | **~$12 USD/mes** |

Esto confirma que el costo de Claude en sí es marginal frente al costo del BSP (ADR-001) y de la infraestructura (ADR-005/006) — el "bajo costo" del proyecto no está en riesgo por la elección del modelo.

## Consecuencias
- El `effort` se deja configurable por tipo de tarea: se puede subir a `high` puntualmente si en el piloto se observan errores de razonamiento en cotizaciones complejas (múltiples productos + promociones combinadas), sin cambiar de modelo.
- Al vencer el precio introductorio (2026-08-31), el costo mensual estimado sube proporcionalmente (~1,5×) — sigue siendo bajo en términos absolutos, pero se debe re-revisar el presupuesto en esa fecha.
- Decisión revisable con datos reales del piloto (Fase 9): si Sonnet 5 muestra errores de tool calling en producción, la escalada a Opus 4.8 es un cambio de un solo parámetro (`model=`), no un rediseño.
