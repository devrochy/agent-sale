# Reglas Explícitas de Escalamiento

Implementa la máquina de estados descrita en la [arquitectura de la Fase 1](../fase-1-arquitectura/arquitectura.md) y el contrato de la tool `escalar_a_humano` ([contratos-tools.md](../fase-1-arquitectura/contratos-tools.md)): **el orquestador decide cuándo escalar mediante reglas explícitas, no el criterio libre del LLM.** Claude puede señalar que algo amerita un humano, pero la decisión final la evalúa código determinístico sobre el estado de la conversación.

## Reglas y sus disparadores

| Regla | Condición de disparo | `reason` en `escalar_a_humano` |
|---|---|---|
| **Intentos fallidos** | El agente no logra resolver la misma necesidad del cliente en 3 turnos consecutivos (ej. sigue preguntando lo mismo, o el agente responde "no tengo esa información" repetidamente) | `intentos_fallidos` |
| **Palabras clave de queja/insatisfacción** | El mensaje del cliente contiene términos asociados a queja (ej. "reclamo", "estafa", "pésimo", "quiero hablar con una persona") — lista de palabras clave configurable por tenant | `queja` |
| **Monto alto** | El total de la cotización o pedido activo supera un umbral configurable por tenant (propuesta inicial para ForMotos: **3× el ticket promedio**, es decir ~$300.000 COP, dato base de la [Fase 0](../fase-0-descubrimiento.md)) | `monto_alto` |
| **Solicitud explícita** | El cliente pide directamente hablar con una persona ("quiero hablar con alguien", "pásame con un asesor") | `solicitud_cliente` |
| **Consulta técnica fuera de catálogo estructurado** | El cliente pregunta algo que el catálogo no puede responder con certeza (ej. compatibilidad técnica específica no modelada — caso ya identificado en la [Fase 0](../fase-0-descubrimiento.md#3-casos-de-uso-priorizados)) | `compatibilidad_tecnica` |
| **Refusal del modelo** | Claude devuelve `stop_reason: "refusal"` (ver [orquestador.md](../fase-4-motor-agente/orquestador.md), Fase 4) | `queja` (tratado como caso ambiguo que requiere revisión humana) |

## Cómo participa el LLM sin tener la decisión final

Claude puede incluir, como parte de su razonamiento normal, una señal de que la conversación parece necesitar un humano (ej. detectar sarcasmo o frustración que no coincide con ninguna palabra clave literal). Esa señal no dispara el escalamiento por sí sola — el orquestador la registra como una "sospecha" y aplica una regla adicional más laxa (ej. "si el LLM sugiere escalar Y ya van 2 turnos sin resolver, escalar") en vez de escalar solo porque el modelo lo sugirió. Esto evita dos fallas opuestas: escalar de más (cada conversación algo tensa termina en un humano, deshabilitando el valor del agente) o escalar de menos (el modelo nunca tiene autoridad real, aunque detecte algo genuino).

## Umbrales configurables, no hardcodeados

El número de intentos fallidos, la lista de palabras clave, y el umbral de monto alto se leen de configuración por tenant (no como valores fijos en el código) — permite ajustar sin redeploy cuando el piloto con ForMotos muestre que un umbral está mal calibrado (ej. escala demasiado seguido, o nunca escala cuando debería).

## Qué pasa después de escalar

Una vez que se dispara cualquiera de estas reglas, el orquestador:
1. Llama a la tool `escalar_a_humano` con el `reason` correspondiente y un resumen generado por Claude de la conversación hasta ese punto (ver contrato en Fase 1).
2. Marca `conversations.state.step = "escalado"` (ver [memoria-conversacional.md](../fase-4-motor-agente/memoria-conversacional.md), Fase 4).
3. El agente **deja de responder automáticamente** en esa conversación — cualquier mensaje nuevo del cliente se encola para el asesor, no se reprocesa con Claude, hasta que un humano cierre el caso (ver [handoff-queue.md](./handoff-queue.md)).

## Qué no cubre este documento
- Implementación real de la detección de palabras clave / conteo de intentos (código) — fuera del alcance de este plan de arquitectura.
- El umbral exacto de "monto alto" — propuesta inicial marcada arriba, a validar con ForMotos durante el piloto (Fase 9).
