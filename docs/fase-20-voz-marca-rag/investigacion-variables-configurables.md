# Investigación: variables configurables adicionales

DoD ítem 3 de [README.md](./README.md). Este documento **investiga y prioriza**, sin comprometer implementación total de antemano — cada candidato queda como propuesta a decidir por separado, no como trabajo ya aprobado.

## Metodología

Revisión del código real para separar dos categorías distintas:
1. Reglas de negocio **hardcodeadas** en `SYSTEM_PROMPT`/código, sin ningún override posible hoy.
2. Reglas ya **configurables a nivel de datos** (columna en `settings`, con función de resolución) pero **sin UI en el panel** — el mecanismo ya existe, falta solo exponerlo.

No se investigó nada relacionado con catálogo/productos (Fase 14 ya lo cubre) ni con promociones/clasificación de clientes (Fase 23 ya lo cubre).

## Lo que ya es configurable hoy (para no duplicar)

Modelo de IA, tono/velocidad de respuesta (ADR-021), voz de marca/RAG institucional (ADR-030, esta fase), destinatarios de reporte diario y de notificaciones de pagos/reseñas, cobros en línea (Wompi) — todo vía `/admin/configuracion`.

## Candidatos investigados

### 1. Panel de UI para `settings.escalation_config` — ya configurable a nivel de datos, sin UI

`src/orchestrator/escalationRules.ts` (`DEFAULT_ESCALATION_CONFIG`) define palabras clave de queja/solicitud de asesor, `maxIntentosFallidos` y `montoAltoThreshold` ($1.000.000 hoy). `resolveEscalationConfig` ya mergea un override desde `settings.escalation_config jsonb` (columna viva desde `migrations/0014`, sobrevivió el retiro de multi-tenancy) — **el mecanismo de persistencia y resolución ya existe y ya se prueba**, solo falta un formulario en el panel para editarlo sin tocar código ni la base directamente.

- **Esfuerzo**: bajo — mismo patrón exacto que `guardarComportamiento`/`guardarVozMarca` (leer, mostrar, validar, `UPDATE ... SET escalation_config`), sin migración nueva ni cambio de `loop.ts`.
- **Valor**: alto — hoy, cambiar el umbral de "monto alto" que dispara escalamiento automático (ej. si sube el ticket promedio del catálogo) requiere un despliegue de código; con UI, es autoservicio como el resto de Configuración.
- **Prioridad recomendada: 1 (siguiente candidato natural a implementar).**

### 2. Horario de atención / mensaje fuera de horario

No existe ningún concepto de horario comercial hoy — el bot responde igual a las 3am que al mediodía. `docs/fase-4-motor-agente/prompt-caching.md` (sección "Riesgo a vigilar") ya documenta explícitamente por qué esto no puede ir como texto interpolado en el `system prompt` (invalidaría el cache en cada llamada) — tendría que resolverse en `messages` (contexto dinámico) o como una tool que el LLM consulte, no como un bloque de cache más.

- **Esfuerzo**: medio — no es un campo de texto más; requiere decidir el comportamiento (¿el bot sigue respondiendo pero avisa "fuera de horario, te contesto un asesor mañana"? ¿deja de responder y escala directo?) y dónde vive ese estado dinámico sin romper el cache jerárquico.
- **Valor**: medio-alto para un negocio con horario de atención humana definido, pero ForMotos hoy no reportó este dolor como el bug de tono/RAG lo hizo.
- **Prioridad recomendada: 2.**

### 3. Mensaje de bienvenida / cierre personalizado

Candidato natural de extender `brandVoiceBlock.ts` con un campo más (ej. `saludoInicial`) — mismo patrón de texto libre con tope de longitud ya implementado en esta fase.

- **Esfuerzo**: muy bajo si se decide hacerlo — un campo más en un módulo que ya existe.
- **Valor**: bajo-medio — el bloque de tono (ADR-021) ya deja ejemplos de saludo por variante; un campo dedicado sería redundante salvo que el negocio quiera un saludo fijo e idéntico en todas las variantes de tono.
- **Prioridad recomendada: 3 (bajo valor incremental, no justifica una sub-fase propia).**

### 4. Política de envío / zonas de cobertura como contexto del agente

Investigado y **descartado por ahora**: el `SYSTEM_PROMPT` ya obliga a no inventar nada que no venga de una tool (`consultar_inventario`, etc.) — agregar política de envío como texto libre en el prompt reintroduce el mismo riesgo que motivó que el catálogo se consulte por tool y no se embeba (ver `prompt-caching.md`, "Qué NO se cachea"). Si el negocio necesita esto, el patrón correcto sería una tool nueva (`consultar_politica_envio` o similar) o datos estructurados por zona, no un bloque de `system` — fuera del alcance de "voz de marca", es una fase de producto aparte si se decide perseguir.

### 5. Límite de descuento negociable por el bot

Investigado y **descartado**: el bot nunca decide descuentos por su cuenta — todo pasa por `aplicar_promocion` (Fase 23), que consulta las promociones reales configuradas en el panel. No hay ningún punto donde el LLM "negocie" un porcentaje que necesite un tope configurable aparte; el guardrail de precios (`priceGuardrail.ts`) ya verifica que ningún monto en la respuesta sea inventado.

### 6. Idioma / moneda por defecto

Investigado y **descartado**: el `SYSTEM_PROMPT` ya instruye responder en el idioma del cliente dinámicamente (no hay "default" que configurar), y el negocio opera en un solo país/moneda (COP) — no hay señal de necesidad multi-moneda tras el retiro de multi-tenancy (ADR-032).

## Recomendación priorizada

1. **UI para `escalation_config`** — esfuerzo bajo, mecanismo ya probado, cierra un hueco real (hoy cambiar el umbral de monto alto exige tocar código).
2. **Horario de atención** — valor real si el negocio lo pide, pero requiere diseño de dónde vive el estado dinámico (no es una extensión trivial del patrón de cache jerárquico); no se investigó a fondo el diseño de la solución, solo se identificó el candidato.
3. **Saludo/cierre personalizado** — trivial de agregar a `brandVoiceBlock.ts` si en el futuro se pide, pero bajo valor incremental sobre lo que ya cubre el tono (ADR-021); no se recomienda como fase propia.

Política de envío, límite de descuento e idioma/moneda por defecto se investigaron y se descartan explícitamente por las razones de arriba — no quedan como candidatos pendientes.
