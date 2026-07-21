# Guardrails de Contenido

## El guardrail principal ya existe desde la Fase 1

El riesgo más grave — que el agente invente un precio, una promoción o una disponibilidad — ya está estructuralmente bloqueado por el principio aplicado desde la Fase 1: **"el LLM propone, la tool decide"**. Claude nunca calcula un precio; siempre lo obtiene de `consultar_inventario` o `generar_cotizacion`, que leen Postgres. Esta fase agrega una capa de verificación adicional y guardrails de tema, no reemplaza ese diseño.

## Guardrail 1: verificación de precios en la respuesta final

Aunque el diseño ya evita que Claude *calcule* precios, nada impide que el modelo, al redactar el texto de la respuesta, transcriba mal un número que sí vino de una tool (ej. un error de transcripción de `$300.000` a `$30.000`). Se agrega una verificación determinística en el orquestador, **después** de que Claude genera la respuesta final y **antes** de enviarla al cliente:

1. Extraer todos los montos en pesos colombianos que aparecen en el texto de respuesta (patrón simple de formato de moneda).
2. Comparar contra los montos que efectivamente devolvieron las tools ejecutadas en ese turno (`audit_log`, Fase 4).
3. Si aparece un monto en el texto que no coincide con ningún monto real de las tools de ese turno, **no se envía la respuesta tal cual** — se registra como incidente de guardrail y se dispara un fallback (reintentar la generación de la respuesta, o si vuelve a fallar, escalar a humano por seguridad).

Esta verificación es barata (comparación de strings/números, no otra llamada a Claude) y cubre el escenario de mayor riesgo de negocio: que el cliente reciba un precio incorrecto por escrito.

## Guardrail 2: límites de tema en el system prompt

El system prompt (Fase 4) incluye instrucciones explícitas de alcance:
- El agente solo habla de productos, pedidos, cotizaciones y promociones de ForMotos — no da opiniones políticas, consejos legales/médicos, ni compara con competidores de forma denigrante.
- Si el cliente pregunta algo fuera de ese alcance, el agente redirige la conversación o, si persiste, dispara la regla de escalamiento por "consulta fuera de alcance" (extensión de las reglas ya definidas en la [Fase 7](../fase-7-escalamiento-humano/reglas-escalamiento.md)).

No se usa un segundo modelo de Claude como "clasificador de guardrail" separado (patrón común en otros sistemas) — sería duplicar el costo de inferencia por turno para un problema que, dado el alcance acotado del caso de uso (ventas de ForMotos), se resuelve razonablemente bien con instrucciones claras en el mismo system prompt. Se revisita si en el piloto se observan desvíos de tema frecuentes que el prompt no logra contener.

## Guardrail 3: `stop_reason: "refusal"` como señal, no como error silencioso

Ya cubierto en el diseño de escalamiento (Fase 7): si Claude rehúsa responder, no se reintenta ciegamente — se trata como señal de escalamiento a humano. Se menciona aquí porque es, en efecto, un guardrail de contenido: el sistema no fuerza al modelo a responder algo que sus propios clasificadores de seguridad bloquearon.

## Qué no cubre este documento
- Implementación real de la extracción/comparación de montos (código) — fuera del alcance de este plan de arquitectura.
- Un guardrail de segundo modelo — descartado deliberadamente por costo/complejidad frente al alcance del caso de uso, ver arriba.
