# ADR-036: Clasificación de cliente en 5 niveles y rediseño de la tabla de Leads

## Estado
Propuesta.

## Contexto

La Fase 17 (ADR-027) implementó una clasificación de 3 niveles (`nuevo`/`recurrente`/`fiel`), derivada exclusivamente del conteo de pedidos no expirados contra dos umbrales de `settings`. Rob pide reemplazarla por 5 niveles con definiciones de negocio explícitas:

- **Cliente nuevo**: quien realiza su primera compra en la tienda.
- **Cliente ocasional**: el que compra de forma esporádica o por una necesidad puntual.
- **Cliente frecuente (recurrente)**: el que regresa a comprar de manera regular en periodos cortos.
- **Cliente fiel (leal)**: el que confía plenamente en la marca, tiene alto grado de satisfacción y la recomienda activamente.
- **Cliente inactivo (en riesgo)**: un cliente frecuente o nuevo que lleva mucho tiempo sin regresar.

A diferencia del esquema de 3 niveles, dos de estas definiciones no son solo una cuestión de *cuántos* pedidos tiene el cliente: "frecuente" vs. "ocasional" es una cuestión de **periodicidad** (¿vuelve seguido o espaciado?), no de volumen puro, e "inactivo" es una cuestión de **recencia** (¿cuánto hace de su último pedido?), ortogonal a las demás. Esto es un cambio de diseño real, no un simple ajuste de umbrales.

## Opciones consideradas

1. **Solo por conteo, agregando dos umbrales intermedios** (nuevo=1, ocasional=2..N-1, frecuente=N..M, fiel=M+, inactivo por recencia) — más simple de implementar, pero "ocasional" y "frecuente" quedarían indistinguibles de dos clientes con el mismo número de pedidos pero ritmos de compra opuestos (uno cada 2 semanas vs. uno cada 8 meses), lo que no refleja la definición de negocio dada.
2. **Conteo + intervalo promedio entre pedidos**, con la recencia del último pedido como criterio de anulación (`inactivo` se evalúa al final y puede sobrescribir cualquier otro resultado) — elegida.

## Decisión

### Datos de entrada por cliente

Sobre `orders WHERE customer_id = $1 AND status != 'expirado' ORDER BY created_at`:
- `count`: total de pedidos no expirados.
- `dias_desde_ultimo_pedido`: `now() - MAX(created_at)`.
- `intervalo_promedio_dias`: si `count >= 2`, promedio de los gaps en días entre pedidos consecutivos ordenados; si `count < 2`, no aplica.

### Umbrales nuevos en `settings` (mismo patrón que `report_frequency_days`, `migrations/0038`)

```sql
ALTER TABLE settings RENAME COLUMN customer_recurrente_min_pedidos TO customer_frecuente_min_pedidos;
ALTER TABLE settings ADD COLUMN customer_frecuente_intervalo_max_dias integer NOT NULL DEFAULT 45;
ALTER TABLE settings ADD COLUMN customer_inactivo_dias_sin_comprar integer NOT NULL DEFAULT 120;
-- customer_fiel_min_pedidos (Fase 17) no cambia de nombre ni de default.
```

Se renombra `customer_recurrente_min_pedidos` en vez de dejarlo y agregar uno nuevo porque es exactamente el mismo concepto ("a partir de cuántos pedidos deja de ser ocasional") con el nombre que ya trae la terminología de 5 niveles — mantener ambos nombres para lo mismo sería confuso sin aportar nada. No existe umbral propio de "ocasional": es el complemento (tiene 2+ pedidos pero no llega a `frecuente` ni a `fiel`).

### Algoritmo (reemplaza el cuerpo de `clasificarCliente()` en `aplicarPromocion.ts`)

```
si count == 0 → nuevo   (cotización sin cliente identificado, mismo caso que hoy)
si count == 1 → nuevo   (ya hizo su primera compra; deja de ser "nuevo" en la segunda — mismo criterio de frontera que ya usaba ADR-027 para nuevo→recurrente)
si count >= customer_fiel_min_pedidos → fiel
si no, si count >= customer_frecuente_min_pedidos
        y intervalo_promedio_dias <= customer_frecuente_intervalo_max_dias → frecuente
si no → ocasional

-- override final, se evalúa siempre después de lo anterior:
si count >= 1 y dias_desde_ultimo_pedido > customer_inactivo_dias_sin_comprar → inactivo
```

El override de `inactivo` se generaliza a **cualquier** clasificación previa, no solo "frecuente o nuevo" como dice literalmente el enunciado de Rob: un cliente `fiel` u `ocasional` que deja de comprar por más de `customer_inactivo_dias_sin_comprar` días es el mismo caso de negocio de riesgo de fuga que un `frecuente` que deja de volver — restringirlo solo a esos dos segmentos habría dejado un cliente `fiel` inactivo clasificado incorrectamente como `fiel` para siempre. Se documenta como decisión explícita a confirmar con Rob antes de implementar, no como lectura literal del enunciado.

### Limitación explícita: "fiel" sigue siendo un proxy por volumen

La definición de negocio de "fiel" (confía plenamente en la marca, alto grado de satisfacción, recomienda activamente) describe una variable de **actitud**, no de **transacciones**. Hoy no existe en el sistema ninguna fuente de datos que mida eso: no hay NPS, encuestas de satisfacción, ni reseñas vinculadas a `customers` (`src/reviews/reviewView.ts` existe pero no está enlazado a clasificación de cliente, y la evaluación de integrarlo con Google My Business está en la Fase 22, todavía sin implementar). Esta fase mantiene el mismo proxy que ya usaba ADR-027 — el segmento de mayor volumen de compra — y dejar documentado que **no** mide lo que la definición de negocio describe literalmente. Cuando exista una fuente real de satisfacción/recomendación (reseñas de Fase 22, o una encuesta futura), esta clasificación debería revisarse; no se bloquea la fase por esto, mismo criterio que ya aplicó ADR-027 al umbral de "fiel" original y Fase 7 al umbral de "monto alto".

### `promotions.eligible_segments`: migración de dato, no solo de código

El valor `'recurrente'` ya sembrado en filas de `eligible_segments` (Fase 17) deja de existir como segmento válido. La migración de esta fase incluye:

```sql
UPDATE promotions SET eligible_segments = array_replace(eligible_segments, 'recurrente', 'frecuente')
WHERE eligible_segments IS NOT NULL AND 'recurrente' = ANY(eligible_segments);
```

para no perder silenciosamente la elegibilidad de una promoción ya creada durante el piloto. El tipo `CustomerSegment` en TS pasa de `"nuevo" | "recurrente" | "fiel"` a `"nuevo" | "ocasional" | "frecuente" | "fiel" | "inactivo"`.

### Rediseño de la tabla de Leads (`renderLeadsPage`)

- **Se quita** la columna "Último mensaje" (era el 44% del ancho de la tabla — el espacio se redistribuye entre las columnas nuevas).
- **Se agrega** "Clasificación": chip con los 5 valores, reutilizando el patrón visual de `LEAD_ESTADO_CHIP` (colores ya disponibles en `STYLE_BLOCK`: `chip--go`, `chip--amber`, `chip--redline`, `chip--muted`, `chip--inactive` — alcanzan para los 5 sin agregar CSS nuevo). Se calcula con la misma función `clasificarCliente()` que ya usa `aplicarPromocion.ts` (se exporta desde ahí o se mueve a un módulo compartido si `adminPanel.ts` no puede importar de `domains/commerce` sin crear una dependencia circular — a resolver en la implementación).
- **Se agrega** "Bot": un toggle/switch por fila. Requiere `customers.bot_paused boolean NOT NULL DEFAULT false` (columna nueva, mismo patrón que `settings.bot_paused` de ADR-020/`migrations/0020`), chequeado en `consumer.ts` y `debounceScheduler.ts` en el mismo punto donde ya se chequea `settings.bot_paused`, combinado con `OR` (si el bot está pausado globalmente **o** para ese cliente puntual, no responde). No depende de la Fase 18 (que plantea un `conversations.bot_paused` a nivel de conversación individual) — son dos flags de nivel distinto (cliente vs. conversación puntual) que, si ambos llegan a existir, se combinan con el mismo `OR`, no se excluyen.
- **Columnas adicionales propuestas** (abiertas a decisión de Rob, no comprometidas en esta ADR):
  - "Pedidos": conteo total no expirado — da contexto inmediato de por qué el sistema asignó cada clasificación, sin tener que abrir el detalle.
  - "Última compra": fecha relativa (ej. "hace 4 meses") — hace visible a simple vista el criterio de inactividad.
  - "Ciudad": de `customers.city` (Fase 15) — útil para logística, dato ya capturado, cero costo de implementación.

### Modal de detalle/edición de lead

Clic en una fila (o un botón dedicado) abre un `<dialog class="modal">` con nombre completo, teléfono (no editable, es la clave del cliente), cédula, dirección, municipio y ciudad — mismo patrón de formulario que "editar colaborador"/"editar aliado". Edita directamente `customers.full_name`/`id_document`/`address`/`municipality`/`city` (columnas de Fase 15, `migrations/0046`) — **no** toca `customers.delivery_*` (esas son la copia temporal de un pedido en curso, Fase 15/ADR-033; editar el perfil permanente del cliente no debe alterar un pedido ya en proceso con datos de entrega distintos).

## Consecuencias

- Se renombra una columna de `settings` ya usada en producción por la Fase 17 (`customer_recurrente_min_pedidos`) — la migración debe ser `RENAME COLUMN`, no `DROP`+`ADD`, para no perder el valor ya configurado (o su default) en el singleton existente.
- La clasificación deja de ser una función pura de un solo número (conteo) a depender de tres umbrales — más superficie para desacuerdos de negocio ("¿por qué soy 'ocasional' si compré 3 veces?"), mismo tipo de riesgo ya anotado en el README de Fase 17, ahora con más parámetros que ajustar.
- "Fiel" sigue sin medir lo que su nombre de negocio promete — riesgo aceptado y documentado, no resuelto por esta ADR.
- El chequeo de bot pausado gana un tercer nivel posible (global → cliente → conversación, este último si la Fase 18 llega a implementarse) — cada nivel adicional multiplica los casos a probar manualmente; la implementación debe agregar un test que cubra la combinación de los niveles que existan en ese momento, no solo cada uno por separado.
