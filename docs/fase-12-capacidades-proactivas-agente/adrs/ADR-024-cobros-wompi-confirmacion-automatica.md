# ADR-024: Cobros por WhatsApp con Wompi y confirmación automática de pago

## Estado

Aceptado.

## Contexto

`analisis-superpoderes.md` (#12, Cobros) y el README de esta fase dejaban pendiente una decisión explícita: si Cobros y/o Multimodalidad ameritan fase propia. `comparativa-arquitectura-forja.md` ya había revisado el esfuerzo de Cobros a la baja (de Alto/Alto a Medio/Bajo) bajo un supuesto concreto: **confirmación manual** — un link de Payment Link pre-configurado (ej. Stripe), y el operador marca el pedido como pagado a mano, igual que hoy con `transferencia`.

El usuario priorizó Cobros, pero con dos ajustes sobre esa estimación:

1. **Wompi en vez de Stripe** — pasarela de Bancolombia, con soporte nativo para tarjeta, PSE, Nequi y transferencia/Bancolombia Collect, más relevante para clientes reales de ForMotos en Colombia.
2. **Confirmación automática de pago** — no manual. El pedido debe aprobarse para el envío sin que el operador tenga que revisar comprobantes, "independientemente de la forma de pago" que use el cliente.

Esta ADR documenta esa reversión de alcance con trazabilidad, no la aplica en silencio.

## Qué existía antes de esta ADR

Ninguno de los 3 métodos de pago (`transferencia`, `efectivo_contraentrega`, `tarjeta`) tenía verificación digital — `crearPedido.ts` marcaba `status: 'confirmed'` incondicionalmente al crear el pedido. No existe (ni existía) un dominio de logística/fulfillment en el sistema — "aprobar el envío" no era un concepto que el código modelara.

## Decisión

### `pago_en_linea` como método nuevo, no una reutilización de `tarjeta`

`tarjeta` significa hoy "paga con datáfono al recibir" — tan no-verificable como efectivo. `pago_en_linea` es conceptualmente distinto: un link que el cliente paga *antes* del envío. Dentro de Wompi, ese único link ya cubre tarjeta, PSE, Nequi y transferencia Bancolombia bajo el mismo webhook `transaction.updated` — así se resuelve el "independientemente de la forma de pago" pedido por el usuario: el pedido nunca necesita saber cuál de esos métodos usó el cliente dentro de Wompi, todos llegan por el mismo evento.

### `orders.payment_status` separado de `orders.status`

Nueva columna (`'pendiente'` | `'pagado'`), default `'pagado'` — preserva el comportamiento de los 3 métodos existentes sin tocarlos (siguen sin verificación, exactamente igual que antes de esta ADR). Solo `pago_en_linea` nace en `'pendiente'` y pasa a `'pagado'` cuando el webhook de Wompi confirma la transacción.

### Llamada externa fuera de la transacción de Postgres

`createPaymentLink` (POST a la API de Wompi) corre **fuera** de cualquier `withTenant` — mismo patrón ya establecido en `escalarHumano.ts` con `sendWhatsAppMessage`: no mantener una transacción abierta mientras se espera una llamada de red externa. Esto obliga a `crearPedido.ts` a partirse en dos fases (chequeo de duplicado/cotización/monto alto de solo lectura → llamada a Wompi si aplica → insert real), en vez de la única transacción que bastaba cuando ningún método de pago hacía I/O externo. La protección real contra duplicados sigue siendo el `UNIQUE` de `idempotency_key` (`ON CONFLICT` + `SELECT` de la carrera), no el límite de la transacción — partirla en dos fases no debilita esa garantía.

Por la misma razón, `createWompiPaymentLink` (la correlación `payment_link_id` → pedido) se llama **después** de que la transacción del pedido ya resolvió (commiteada) — insertarla *dentro* de esa transacción violaría el FK a `orders`, ya que esa fila todavía no sería visible desde otra conexión hasta el `COMMIT`.

### Ambiente por prefijo de llave, no un campo nuevo

Wompi expone sandbox (`prv_test_...`) y producción (`prv_prod_...`) como hosts distintos (`sandbox.wompi.co` / `production.wompi.co`). Se detecta por el prefijo de la llave privada en vez de agregar un campo de "ambiente" redundante en la config del tenant.

### Correlación `payment_link_id` sin RLS

Tabla nueva `wompi_payment_links` (migración `0031`), **sin RLS** — mismo criterio que `handoff_tokens`/`review_tokens`: el webhook de Wompi llega sin saber a qué tenant pertenece, y resolver `payment_link_id` es el paso previo a poder abrir una sesión con `app.tenant_id`.

### BYOK por tenant, mismo patrón que ADR-020

`tenants.wompi_private_key_encrypted` / `wompi_events_secret_encrypted` (migración `0032`), cifrados con `secretBox.ts`. Sin llaves de plataforma en `env.ts` — cada tenant trae su propia cuenta de Wompi. El secreto de eventos solo se usa para verificar la firma de los webhooks entrantes, nunca para llamar a la API de Wompi.

### "Aprobar el envío" reutiliza el canal del Reporte diario, no un dominio de logística nuevo

No existe (ni se construye acá) un módulo de fulfillment. Cuando el webhook confirma un pago, se notifica por WhatsApp a `tenants.report_recipient_phone` (mismo destinatario configurado para el Reporte diario, ADR-018) con el resumen del pedido — reutilización deliberada del mismo operador/canal en vez de un tipo de contacto nuevo ("logística"). Si en el futuro ForMotos necesita un contacto distinto para esto, es una iteración menor sobre este mismo mecanismo, no un rediseño.

### DECLINED/ERROR: solo log en v1

Un intento de pago rechazado no notifica proactivamente al cliente (ya ve la pantalla de error de Wompi en el navegador) ni bloquea el link (no es de un solo intento — `single_use` en la API de Wompi significa "una transacción *aprobada*", los rechazos no lo consumen). Evita ampliar el alcance en la primera iteración; es una extensión natural si se necesita después.

### Bug real encontrado en QA: Wompi exige una base de transacción ≥ $150.000 COP

Probando "Probar y guardar" contra el sandbox real con un monto de prueba de $1.000 COP, Wompi rechazó la creación del link con 422: `"La base de la transacción debe ser igual o mayor a 150000..."` — un mínimo no documentado explícitamente en la guía de Links de pago. Esto no es solo un problema del monto de prueba: cualquier cotización real por debajo de $150.000 (ej. un solo par de guantes) fallaría igual al intentar `pago_en_linea`. Corregido con `MIN_AMOUNT_COP` (`wompiClient.ts`), chequeado en `crearPedido.ts` **antes** de llamar a la API — devuelve `status: 'wompi_monto_minimo'` (mismo estilo que `wompi_no_configurado`: sin crear pedido, sin llamar a Wompi) en vez de dejar que la tool lance un error crudo de la API que el LLM tendría que interpretar. "Probar y guardar" pasa a usar `MIN_AMOUNT_COP` como monto de prueba en vez de un valor arbitrario.

### Extracción determinística del link de pago

Mismo criterio que `mediaUrl`/`extractSingleMatchImageUrl` en `loop.ts` — nunca se confía en que el LLM copie el link correctamente. `extractPaymentLinkUrl` lee `payment_link_url` del resultado de `crear_pedido` y lo anexa al `responseText` final, después de los guardrails de precio/stock (para no dispararlos con la URL) y antes del split de burbujas (`messageSplitter.ts`, ADR-021) — queda como su propio mensaje de WhatsApp.

## Consecuencias

- Un tenant sin Wompi configurado que recibe `payment_method: pago_en_linea` obtiene `status: 'wompi_no_configurado'` (sin crear pedido, sin llamar a Wompi) — el LLM lo narra y ofrece otro método, nunca confirma un pedido que no puede cobrarse. Lo mismo aplica a `status: 'wompi_monto_minimo'` cuando el total es menor a `MIN_AMOUNT_COP` ($150.000 COP).
- Pasar a producción real requiere que ForMotos abra una cuenta comercial de Wompi (decisión de negocio) — mismo tipo de prerrequisito que `pendientes-pre-piloto.md` documentó para la cuenta BSP de WhatsApp (Fase 9). No bloquea el desarrollo: se construye y prueba contra sandbox.
- Reintentos de webhook de Wompi (hasta 3 en 24h si no se responde 200) son inofensivos: la actualización es idempotente (`WHERE payment_status = 'pendiente'`), así que un reintento después de ya confirmado no vuelve a notificar al operador.
- `/admin/:tenantId/analitica` gana una sección "Pagos en línea" (confirmados, monto, pendientes) — dato que antes no existía en ningún lado del panel.
