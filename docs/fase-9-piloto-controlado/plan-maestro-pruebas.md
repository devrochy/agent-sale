# Plan maestro de pruebas (pre-producción)

Checklist manual de todo lo que hay que validar antes de pasar a producción real (Fase 9). Complementa, no reemplaza, lo que ya existe:

- [eval-suite.md](./eval-suite.md) — golden set **automatizado** de escenarios conversacionales contra el LLM real (diseñado, no implementado todavía — `eval/` no existe en el repo). Este documento es manual y cubre además todo lo que el golden set no toca: panel admin, jobs programados, Wompi, seguridad.
- [pendientes-pre-piloto.md](./pendientes-pre-piloto.md) — ejecución de negocio (cuentas reales, pagos). Este documento asume que todavía se prueba contra **sandbox** (Twilio Sandbox, Wompi sandbox, LLM que tengas configurado) — no dupliques ahí la checklist de cuentas reales.

## Cómo usar esto

Marcá `[x]` a medida que probás. Cuando algo no se comporte como describe el "Resultado esperado", anotalo debajo de esa fila con el formato `> HALLAZGO: ...` — esas anotaciones son la entrada de las mejoras que vas a pedir después. No corrijas nada vos mismo en el código; documentá y seguimos juntos.

## Entorno necesario antes de empezar

Ver [guia-ejecucion-local.md](../guia-ejecucion-local.md) para el manual completo paso a paso (prerrequisitos, cuentas, `.env`, comandos) — acá solo el resumen mínimo para correr esta checklist:

- [ ] Servidor local corriendo (`npm run build && node dist/src/index.js`, o `npx tsx src/index.ts`) con Postgres y Redis locales arriba (`docker-compose up -d postgres redis`).
- [ ] Un túnel público (`cloudflared tunnel --url http://localhost:3000`) si vas a probar webhooks reales de Twilio o Wompi — actualizá `PUBLIC_WEBHOOK_URL` en `.env` y reiniciá el servidor cuando cambie.
- [ ] Un tenant real de prueba con catálogo cargado (podés reusar "ForMotos Test" — recordá limpiar los datos de la corrida cuando termines, ver "Limpieza" al final).
- [ ] Al menos un proveedor de LLM con key real disponible (hoy DeepSeek, ver `project_deepseek_temporal` — Claude sigue siendo la decisión de producción, ADR-008).
- [ ] Cuenta sandbox de Wompi Colombia (llave `prv_test_...` + secreto de eventos) si vas a probar Cobros.
- [ ] `ADMIN_USER`/`ADMIN_PASSWORD` de tu `.env` a mano — todo `/admin/*` pide Basic Auth.

---

## Parte 1 — Escenarios de punta a punta

Cada uno se prueba mandando mensajes reales por WhatsApp (Twilio Sandbox) o simulando el webhook firmado — no alcanza con mirar el código, tiene que pasar por el flujo real.

### 1. Compra completa con transferencia (camino feliz)
- [x] Preguntar por un producto real del catálogo → el bot responde precio/stock reales (nunca inventados).
- [x] Pedir la foto de un producto puntual → llega la imagen si el producto tiene `image_url`.
- [x] Pedir cotización de 2+ productos → el total coincide con lo que hay en `quotes.total`.
- [x] Confirmar el pedido con "transferencia" y "domicilio" → el bot no menciona `quote_id`/`order_id`, confirma por contenido.
- [x] Verificar en Postgres: `orders.status = 'confirmed'`, `payment_status = 'pagado'` (default), stock descontado en `inventory`.
- [x] Reenviar el mismo mensaje de confirmación (mismo `MessageSid`) → responde "duplicate" sin crear un segundo pedido ni descontar stock de nuevo.

> **Probado 2026-07-30** contra "ForMotos QA": Casco Integral Thunder Road, $380.000 → pedido confirmado, stock 12→11, reenvío del mismo `MessageSid` no duplicó nada. Sin hallazgos.

### 2. Compra con pago en línea (Wompi) de punta a punta
- [x] Configurar Wompi en `/admin/:tenantId/configuracion` (sección "Cobros en línea") con llave sandbox real — "Probar y guardar" debe pasar (usa `MIN_AMOUNT_COP` = $150.000 como monto de prueba).
- [x] Pedir un producto de **al menos $150.000** con "pago en línea" → el bot devuelve un link real `https://checkout.wompi.co/l/...` como su propio mensaje.
- [x] Verificar `orders.payment_status = 'pendiente'`, `wompi_payment_link_id` seteado.
- [x] Pedir un producto de **menos de $150.000** con pago en línea → responde `wompi_monto_minimo`, ofrece otro método, **no** crea el pedido.
- [x] Sin Wompi configurado (tenant nuevo) → responde `wompi_no_configurado`, ofrece otro método. *(validado en la ronda anterior contra el tenant viejo, mismo código)*
- [x] Pagar el link real con tarjeta de prueba aprobada (sandbox) → el webhook `/webhooks/wompi` confirma, `payment_status` pasa a `'pagado'`, `paid_at`/`wompi_transaction_id` se llenan.
- [x] Llega el WhatsApp de "aprobar el envío" a `report_recipient_phone` (sin errores en el log).
- [x] Repetir con tarjeta de prueba **declinada** → el pedido queda `pendiente` (nunca se marca pagado), no se notifica al operador.
- [x] Reenviar el mismo evento de Wompi (duplicar el POST) → responde 200, no vuelve a notificar (idempotencia). *(validado en la ronda anterior)*
- [x] Un webhook con checksum alterado → responde 400, no toca el pedido. *(validado en la ronda anterior)*
- [x] La transcripción en `/asesor/:token` o Conversaciones muestra el link de pago igual que lo recibió el cliente (no solo el texto sin el link).

> **Probado 2026-07-30** contra "ForMotos QA": Kit de Mangueras ($130.000) → `wompi_monto_minimo`, 0 pedidos creados. Casco Infantil SafeKid ($150.000) → link real `test_CrYn4m`, pagado con tarjeta aprobada, webhook confirmó en segundos. Segundo pedido igual, pagado con tarjeta declinada (`test_jvQYcO`) → quedó `pendiente`, log mostró "Transacción de Wompi no aprobada". Sin hallazgos.

### 3. Escalamiento por queja
- [x] Mandar un mensaje con una queja explícita → escala, el cliente recibe el mensaje de fallback, no una respuesta automática más.
- [x] La conversación aparece en Tickets (`/admin/:tenantId/tickets`) y en la vista del asesor (`/asesor/:token`, notificación por WhatsApp a `human_agents`).
- [x] "Tomar conversación" y "Resolver" desde `/asesor/:token` funcionan y cambian el estado.
- [x] Al resolver, se dispara la encuesta de satisfacción (ver escenario 8).
- [ ] Mandar un mensaje nuevo a una conversación **ya escalada** → se guarda en el historial pero **no** se responde automáticamente (verificar `messages` tiene la fila, no hay outbound nuevo).

> **Probado 2026-07-30**: "Estoy MUY molesto..." + "quiero hablar con una persona YA" → escaló con `reason: solicitud_cliente` (la regla de palabra clave "hablar con una persona" se disparó antes que el LLM llegara a clasificarlo como `queja` — comportamiento esperado del diseño, la regla determinística corta primero). Tomar → `en_atencion`, Resolver → `resuelto` + conversación `closed` + encuesta disparada automáticamente. Sin hallazgos de bug, solo la nota de motivo de escalamiento arriba.

### 4. Escalamiento por monto alto
- [x] Cotizar algo por encima del umbral configurado (`escalation_config`/default) y confirmar el pedido → escala con `reason: 'monto_alto'` **antes** de que exista el `order` — verificar en Postgres que no se creó ninguna fila en `orders` para esa cotización.

> **Probado 2026-07-30**: 2x Escape Completo Racing ($1.900.000, umbral default $1.000.000) → escaló con `monto_alto`, 0 pedidos creados. Sin hallazgos.

### 5. Guardrails de precio y stock forzados
- [ ] Es difícil de forzar por conversación normal — si el modelo transcribe mal un precio/stock alguna vez durante las pruebas, confirmar en los logs `orchestrator.guardrail_precio_incidente` / `guardrail_stock_incidente`, que reintentó una vez, y que si persiste escaló con el motivo correspondiente (nunca se manda el precio/stock inventado al cliente).

> **Observado 2026-07-30**: 0 incidentes de guardrail en toda la corrida de hoy (10+ conversaciones) — resultado esperado en el camino feliz, no se forzó el caso adverso a propósito.

### 6. Fuera de alcance
- [x] Preguntar algo fuera de ForMotos (política, medicina, competencia) → redirige una vez.
- [x] Insistir → escala con `reason: 'fuera_de_alcance'`.

> **Probado 2026-07-30**: "¿Qué opinas del presidente de Colombia?" → redirigió. Insistir una vez → redirigió de nuevo (no escaló todavía). Insistir una segunda vez pidiendo hablar con alguien → recién ahí escaló con `fuera_de_alcance`.
> HALLAZGO: tomó 2 redirecciones en vez de 1 antes de escalar — el system prompt dice "si insiste, escala", pero el modelo redirigió dos veces. No es un error grave (eventualmente escaló), pero vale la pena revisar el prompt si se quiere un límite más estricto de 1 sola redirección.

### 7. Debounce / Velocidad de respuesta
- [x] Configurar "Rápido" (5s) o "Normal" (15s) en Configuración → Voz y estilo.
- [x] Mandar 2-3 mensajes seguidos rápido (menos que el delay configurado) → el bot responde **una sola vez**, considerando todos los mensajes juntos (no una respuesta por mensaje).
- [ ] Volver a "Inmediato" y confirmar que vuelve a responder mensaje por mensaje sin delay.

> **Probado 2026-07-30**: "Hola" + "quiero guantes" + "de cuero, talla M" mandados en <1s entre sí → una sola respuesta agrupada y coherente sobre guantes de cuero talla M. Sin hallazgos.

### 8. Encuestas de satisfacción + Reseñas propias
- [x] Resolver una conversación escalada (o cerrarla) → llega la encuesta ("¿cómo calificarías tu experiencia, 1 al 5?").
- [x] Responder con una calificación alta (4-5) → agradecimiento + link propio `/resena/:token` (no un link externo directo).
- [x] Abrir el link, escribir una reseña real → queda en `reviews` con el `score` copiado de la encuesta.
- [x] Visitar el link una segunda vez → ya no muestra el formulario ("ya enviaste tu reseña").
- [ ] Si `tenants.review_link` (externo) está configurado, aparece el botón "Compartir en Google" → al usarlo, redirige 302 y marca `reviews.shared_publicly = true`. *(pendiente — no configuramos review_link externo en esta corrida)*
- [ ] Responder con calificación baja (1-3) → agradece sin ofrecer ningún link. *(pendiente)*
- [x] Verificar en Analítica: promedio, distribución 1-5, y la reseña aparecen.

> **Probado 2026-07-30**: score 5 → link `/resena/:token` real, reseña escrita ("Excelente atención..."), guardada con `score: 5`, segunda visita mostró "¡Gracias por tu reseña!". Analítica mostró "1 calificaciones" y el pago en línea correcto. Sin hallazgos. Falta probar score bajo y compartir en Google en una próxima corrida.

### 9. Cazador de ventas (cotizaciones frías)
- [x] Generar una cotización real y **no** confirmarla.
- [x] Esperar (o adelantar manualmente `quotes.created_at` en la base) a que caiga en la ventana de 3-20h sin `orders` asociado.
- [x] Disparar el job manualmente (o esperar la corrida horaria) → llega un mensaje de reenganche por WhatsApp, **solo si** el último mensaje del cliente fue hace menos de 24h (ADR-019).
- [x] Confirmar que no se manda dos veces para la misma cotización (`quotes.follow_up_sent_at`).

> **Probado 2026-07-30**: cotización de Casco Thunder Road, `created_at` adelantado 5h, job disparado manualmente. El envío real falló por límite diario de Twilio Sandbox (error 429/63038, ver hallazgo de infraestructura abajo) — pero el manejo del error fue correcto: `follow_up_sent_at` quedó `NULL` (no se marcó como enviado), así que la próxima corrida del job reintentará solo. La lógica de "no reintentar dos veces si ya se envió" no se pudo ejercitar con un envío exitoso real en esta corrida — pendiente repetir cuando el límite de Twilio se resetee.
> HALLAZGO (infraestructura, no del código): Twilio Sandbox tiene un límite diario de mensajes gratuitos — una sesión de pruebas intensiva (10+ conversaciones) lo agota. Para pruebas de producción real hace falta una cuenta con pago (ver `pendientes-pre-piloto.md`, punto 1).

### 10. Reporte diario
- [x] Configurar un teléfono en "Reporte diario" (Configuración).
- [ ] Disparar el job (`sendDailyReports`) manualmente o esperar las 8:00 a.m. Bogotá. *(bloqueado por el límite de Twilio de esta corrida, ver escenario 9)*
- [ ] Llega el resumen de ayer (mensajes, clientes únicos, conversaciones cerradas/escaladas, pedidos confirmados, monto). *(pendiente)*
- [ ] Dejar el teléfono vacío → ese tenant no recibe nada (no es un error). *(pendiente)*

---

## Parte 2 — Checklist detallado por módulo

### A. Gateway de WhatsApp (`/webhooks/whatsapp`)
- [ ] Firma de Twilio inválida → 403, no se encola nada.
- [ ] `To` desconocido (número que no es de ningún tenant) → 200, no se encola (evita reintentos de Twilio).
- [ ] Mismo `MessageSid` reenviado → no se duplica en el stream de Redis.
- [ ] Rate limit por IP (60/min) → pasado el límite, responde 429.
- [ ] `ProfileName` de Twilio se guarda/actualiza como nombre del cliente.

### B. Multi-tenant y seguridad
- [x] Dos tenants distintos, mismo proceso: catálogo/precios/clientes de uno nunca aparecen en respuestas del otro (aislamiento RLS). *(cubierto por `tests/integration/rls-isolation.test.ts`, ya verde en la suite automatizada — no se recreó manualmente para no volver a tener más de un tenant)*
- [x] Todas las rutas `/admin/*` piden Basic Auth (`ADMIN_USER`/`ADMIN_PASSWORD`) — sin credenciales, 401.
- [x] Rutas públicas (`/webhooks/*`, `/asesor/:token`, `/resena/:token`) **no** piden Basic Auth.
- [x] Un token de asesor/reseña inválido devuelve 404, no expone datos de otro tenant.
- [x] `audit_log` no se puede editar ni borrar (confirmado con un DELETE de prueba real durante la limpieza de tenants — el trigger lo bloqueó como se esperaba).

### C. Motor del agente — cada tool
- [ ] `consultar_inventario` — un match único incluye `image_url` si el producto tiene foto; varios matches no ofrecen enviar foto de ninguno.
- [ ] `generar_cotizacion` — el total nunca lo calcula el modelo, siempre viene de la tool.
- [ ] `aplicar_promocion` — nunca inventa un descuento que la tool no confirmó; aplica la de mayor beneficio, nunca combina dos.
- [ ] `crear_pedido` — los 4 métodos de pago (`transferencia`, `efectivo_contraentrega`, `tarjeta`, `pago_en_linea`) y los 2 de entrega (`domicilio`, `recoger_en_tienda`) funcionan.
- [ ] `recomendar_producto` — sugiere complementarios de forma natural, no en cada mensaje.
- [ ] `escalar_a_humano` — los 6 motivos que el LLM puede elegir libremente (`compatibilidad_tecnica`, `solicitud_cliente`, `intentos_fallidos`, `queja`, `fuera_de_alcance` — y confirmar que **nunca** elige por su cuenta `guardrail_precio`/`guardrail_stock`, esos son internos del orquestador).
- [ ] El SKU y cualquier `quote_id`/`order_id` nunca aparecen en un mensaje al cliente.

### D. Escalamiento — los 8 motivos reales
`compatibilidad_tecnica`, `monto_alto`, `solicitud_cliente`, `intentos_fallidos`, `queja`, `guardrail_precio`, `fuera_de_alcance`, `guardrail_stock` — cada uno:
- [x] Aparece correctamente etiquetado en Tickets. *(confirmado para `solicitud_cliente`, `monto_alto`, `fuera_de_alcance` — faltan `compatibilidad_tecnica`, `intentos_fallidos`, `queja` propiamente dicha, `guardrail_precio`, `guardrail_stock` en una próxima corrida)*
- [ ] `queja`/`monto_alto` aparecen marcados como "en riesgo" (`RISKY_REASONS`) en la UI. *(pendiente de confirmar visualmente)*
- [x] Notifica por WhatsApp al primer `human_agent` activo del tenant (si hay uno configurado) — si falla el envío (ej. sin Twilio real), el caso igual queda en `handoff_queue` (best-effort, no bloquea).

### E. Panel admin — página por página
Para cada página: cargar con Basic Auth válido, confirmar que no tira 500, que los datos mostrados coinciden con lo que hay en Postgres para ese tenant.

- [x] **Resumen** (`/admin/:tenantId`) — KPIs, actividad reciente, marca (`display_name`) del tenant. *(carga 200, contenido no inspeccionado en detalle)*
- [x] **Conversaciones** (`/admin/:tenantId/conversaciones`) — filtros por estado, última conversación con mensajes aparece; una sin mensajes (ver nota de `audit_log` en limpieza) **no** aparece (usa `JOIN`, no `LEFT JOIN`).
- [x] **Leads** (`/admin/:tenantId/leads`) + **exportar CSV** (`/admin/:tenantId/leads.csv`) — el CSV abre bien y coincide con la tabla. *(ver limitación real documentada arriba en "Limpieza": Leads nunca queda en cero en un tenant reusado)*
- [x] **Tickets** (`/admin/:tenantId/tickets`) — lista agregada de `handoff_queue`, motivos correctos.
- [x] **Analítica** (`/admin/:tenantId/analitica`):
  - [ ] Costo del mes, tokens, costo por conversación con/sin pedido — cambiar de moneda (selector) y confirmar que convierte bien (o cae a USD si no hay tasa disponible). *(carga bien, selector de moneda no probado)*
  - [ ] Gráfico de costo 30 días. *(no inspeccionado visualmente)*
  - [x] Satisfacción (promedio + distribución 1-5) y reseñas recientes. *(mostró "1 calificaciones" correctamente)*
  - [x] Pagos en línea (confirmados, monto, pendientes) — coincide exacto: 1 confirmado, $150.000, 1 pendiente.
- [x] **Flujo** (`/admin/:tenantId/flujo`) — diagrama estático, contadores reales por tool. *(carga 200, contadores no verificados en detalle)*
- [x] **Conexiones** (`/admin/:tenantId/conexiones`) — número de WhatsApp del tenant se muestra correcto.
- [x] **Configuración** (`/admin/:tenantId/configuracion`):
  - [ ] Estado del bot — pausar/reactivar realmente detiene/reanuda las respuestas automáticas (mensajes se siguen guardando pausado). *(pendiente, no probado en esta corrida)*
  - [x] Modelo de IA — "Automático" quedó seleccionado por default (sin config), confirmado en el HTML. Ruteo automático/BYOK explícito no probado en esta corrida.
  - [x] Voz y estilo — Tono/Estilo/Velocidad guardados vía endpoint real y confirmados en `behavior_config` (ver escenario 7).
  - [x] Reporte diario — teléfono guardado y confirmado en Postgres.
  - [ ] Encuestas y reseñas — guardar/vaciar link externo. *(no probado en esta corrida)*
  - [x] Cobros en línea — llave+secreto guardados, "Probar y guardar" pasó tras corregir `MIN_AMOUNT_COP`.
- [x] **Productos** (`/admin/:tenantId/productos`) — catálogo real visible (101 productos copiados).
- [x] **Pedidos** (`/admin/:tenantId/pedidos`) — pedidos reales de hoy aparecen con su `payment_status` correcto.

### F. Jobs programados
- [x] Ambos cron (`0 8 * * *` Reporte diario, `0 * * * *` Cazador de ventas) están registrados al arrancar (`startJobScheduler`, ver logs de arranque). *(confirmado que `runCazadorDeVentas` se puede disparar manualmente e importarse sin levantar el cron completo)*
- [ ] Un error dentro de un job no tumba el proceso ni afecta el webhook (probar forzando un error, ej. tenant sin config). *(el error real de Twilio 429 durante el escenario 9 no tumbó el proceso — buena señal indirecta, pero no se probó a propósito)*

### G. Seguridad / observabilidad
- [x] Logs estructurados (JSON) presentes para cada evento relevante (`gateway.mensaje_recibido`, `orchestrator.tool_completada`, `orchestrator.escalado`, `wompi.pago_confirmado`, etc.) — útil para diagnosticar sin tocar la base.
- [x] Secretos (API keys de LLM, llaves de Wompi) nunca aparecen en texto plano en la base — confirmado, la llave de Wompi de ForMotos QA está en formato `iv:authTag:ciphertext`.

---

## Resumen de la corrida del 2026-07-30

Contra el tenant "ForMotos QA" (fresco, catálogo real, sin config previa): **7 de 10 escenarios de punta a punta completos**, gran parte del checklist de módulos verificado. Bloqueado por el límite diario de mensajes de Twilio Sandbox (no es un bug del sistema) para: envío real del Cazador de ventas, Reporte diario, y cualquier prueba adicional que requiera WhatsApp saliente — retomar cuando se resetee el límite o con una cuenta Twilio de pago.

Hallazgos abiertos para convertir en mejoras:
1. Fuera de alcance tomó 2 redirecciones antes de escalar, en vez de 1 (system prompt dice "si insiste, escala").
2. Twilio Sandbox (gratis) tiene límite diario de mensajes — no sirve para una sesión de pruebas intensiva ni para producción real (ya conocido, ver `pendientes-pre-piloto.md`).

---

## Limpieza después de probar

`audit_log` es inmutable (no se puede editar ni borrar, por diseño) — cualquier conversación con actividad real queda con su `conversation`/`customer` "vivos" para siempre, aunque sin mensajes. Para dejar el tenant de pruebas limpio antes de la próxima ronda:

1. Borrar (en este orden, por las FK): `wompi_payment_links` → `order_items` → `orders` → `quote_items` → `quotes` → `handoff_tokens` → `handoff_queue` → `review_tokens` → `reviews` → `llm_usage` → `messages`, todo filtrado por `tenant_id` (y `created_at`/`conversation_id` si es solo una corrida puntual, no un reset completo).
2. **No** intentar borrar `conversations`/`customers`/`audit_log` — quedan inertes por diseño.
3. Limpiar también los campos que viven directo en `conversations` y no se borran solos con el paso 1: `UPDATE conversations SET satisfaction_score = NULL, survey_sent_at = NULL, survey_reply_processed_at = NULL WHERE tenant_id = '<id>'` — si no, Analítica → Satisfacción sigue mostrando datos viejos aunque `reviews` esté vacía.

### Limitación real, ya confirmada: Leads nunca queda en cero

`renderLeadsPage` consulta `FROM customers` directo (no pasa por `conversations`/`messages`) — a diferencia de Conversaciones, que sí depende de que existan mensajes. Como los `customers` de prueba **nunca se pueden borrar** (bloqueados transitivamente por `conversations` → `audit_log`), la página de Leads va a seguir mostrando esos clientes viejos para siempre, aunque figuren sin actividad (`sin_actividad_comercial`) y sin último mensaje. **La única forma de tener Leads realmente en cero es probar contra un tenant nuevo**, no limpiar el actual.

## Después de esto

Documentá acá abajo (o en un archivo aparte) cada `> HALLAZGO` que encontraste, para convertirlos en pedidos de mejora concretos en la próxima ronda.
