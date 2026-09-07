# Plantillas de mensajes de WhatsApp (Meta)

## Por qué existen
Dentro de las 24 horas posteriores al último mensaje del cliente, el agente puede responder libremente con texto normal ("mensaje de servicio", gratuito — ver [ADR-001](../fase-1-arquitectura/adrs/ADR-001-bsp-whatsapp.md)). **Fuera** de esa ventana, WhatsApp solo permite enviar **plantillas pre-aprobadas por Meta** (categorías `UTILITY`, `MARKETING`, `AUTHENTICATION`). Es el caso, por ejemplo, de una confirmación de pedido que se manda horas después de la última respuesta del cliente, o de una promoción que el negocio quiera enviar de forma proactiva.

> Este documento reemplaza la versión original (pensada para plantillas gestionadas desde Twilio, nunca implementada). Desde la [Fase 19, Etapa B](../fase-19-integracion-multicanal/README.md) las plantillas se gestionan directo contra la Graph API de Meta, desde el panel (`/admin/plantillas`, solo rol master) — alta, sincronización de estado y envío de prueba, sin intermediario.

## Proceso de aprobación
1. Se crean desde `/admin/plantillas` (conexión de WhatsApp/Meta → nombre, categoría, idioma, cuerpo con variables `{{n}}`, botones opcionales) — el formulario valida en el cliente las reglas de Meta que más rechazos generan: ninguna variable pegada al principio o al final del cuerpo, botones de hasta 25 caracteres, URL del botón de enlace con HTTPS y una sola variable dinámica al final.
2. Meta revisa el contenido — puede aprobar, rechazar o pedir cambios. Las de categoría `MARKETING` tienen un estándar más estricto que `UTILITY` (más fricción/tiempo esperado).
3. El botón "Sincronizar" del panel refleja el estado real (`pending` / `in_review` / `approved` / `rejected` / `paused` / `disabled`).
4. Solo se puede **enviar** una plantilla con estado `approved` — el código (`resolveApprovedTemplate.ts`) resuelve conexión + plantilla aprobada por nombre exacto antes de cualquier envío proactivo; si no está aprobada, cada disparador degrada de forma explícita (ver columna "Si no está aprobada" más abajo).

## Regla de diseño para el agente
El agente (Claude) **nunca decide el texto exacto de una plantilla** — decide *cuándo* corresponde enviarla y con qué variables; el texto en sí está fijo y aprobado, coherente con "el LLM propone, la tool decide" (Fase 1). Ídem para el tono: ninguna plantilla abre con un saludo ("Hola") — todas asumen que continúan una conversación ya en curso, nunca que la abren. **Excepción deliberada:** `carrito_abandonado` sí abre con un saludo desde la revisión de 2026-09-06 — es la única que reengancha una conversación fría por días, no una que sigue en curso (ver nota en su detalle).

## Catálogo vigente

| Plantilla | Categoría | Se dispara desde | Si no está aprobada |
|---|---|---|---|
| `pedido_confirmado_v3` | Utility | `cerrarPedido.ts` (tool `cerrar_pedido`) | No cierra el pedido con plantilla (ni manda `confirmar_domicilio`, que depende del mismo envío); `cerrar_pedido` devuelve `plantilla_no_aprobada` y el LLM sigue por texto libre |
| `metodo_pago` | Utility | `preguntarMetodoPago.ts` (tool `preguntar_metodo_pago`) | Ídem, sin fallback de texto libre |
| `confirmar_domicilio` | Utility | `cerrarPedido.ts` (2do envío, best-effort) + `confirmarDomicilioPedido.ts` (reenvío desde el panel) | El cierre del pedido no falla (`domicilio_status: "plantilla_no_aprobada"`); el panel puede reenviarla después o el admin confirma a mano — si no está aprobada tampoco se puede usar `actualizar_direccion_pedido` (depende del mismo envío) |
| `pago_aprobado` | Utility | `notificarPagoCliente.ts` (webhook de Wompi, pago `APPROVED`) | No se manda nada al cliente (los admins sí se enteran, por otro camino) |
| `pago_rechazado` | Utility | `notificarPagoCliente.ts` (webhook de Wompi, pago `DECLINED`/`VOIDED`/`ERROR`) | Ídem |
| `pedido_en_camino` | Utility | `registrarGuia.ts` (al registrar la guía por primera vez) | Cae al texto libre de siempre — sin regresión, solo pierde alcance fuera de la ventana de 24h |
| `carrito_abandonado` | **Marketing** (ver nota) | `reactivarCotizacionesFrias.ts` (cron horario) | La cotización sigue candidata en la próxima corrida (no se marca como intentada) |
| `pedido_cancelado` | Utility | `notificarPedidoCancelado.ts` (tool `cancelar_pedido` y panel) | No se manda nada al cliente |
| `promocion_general` | Marketing | Botón "Mandar promoción" en Leads (`enviarPromocionCliente`, `adminPanel.ts`) | No aparece en el selector del panel (solo lista `MARKETING` + `approved`) |

## Detalle por plantilla

### `pedido_confirmado_v3`
- **Variables:** `{{1}}` nombre del cliente · `{{2}}` número de pedido · `{{3}}` monto · `{{4}}` método de entrega
- **Cuerpo:** `✅ ¡Gracias, {{1}}! Tu pedido #{{2}} por {{3}} quedó confirmado. 📦 Entrega: {{4}}. Cualquier cosa, estamos acá para ayudarte.`
- **Ejemplos:** `Juan Pérez, FM-0001, $150.000, Domicilio`
- **Botones:** 3 Quick Reply — `Agregar productos` · `Cancelar pedido` · `Confirmar y pagar`
- **Código:** `src/domains/commerce/cerrarPedido.ts`; el botón `Confirmar y pagar` lo resuelve `src/domains/commerce/confirmarPagoPedido.ts` (tool `confirmar_pago_pedido`).
- ⚠️ **Por qué "_v3" y no `pedido_confirmado` a secas:** `Confirmar y pagar` era un botón `URL` (`https://formotos.com/pago/{{1}}`, un sitio que nunca se conectó a este backend) — pasaba a ser un Quick Reply más, y Meta no tiene forma de *editar* una plantilla aprobada, así que había que borrarla y recrearla. Al intentar recrearla el 2026-09-06 con el mismo nombre, Meta rechazó la creación bloqueando reusar el nombre de una plantilla recién borrada — pero el tiempo de espera que reporta en el mensaje **no es confiable**: la primera vez dijo "4 weeks", la segunda (con `_v2`, borrada sin querer por un bug del script de creación) dijo "less than 1 minute" y siguió bloqueada más de 5 minutos de reintentos. En vez de seguir reintentando a ciegas, se creó con `_v3`. Ninguno de los nombres anteriores (`pedido_confirmado`, `pedido_confirmado_v2`) se vuelve a intentar por ahora — si en el futuro se necesita recrear esta plantilla de nuevo, mejor asumir directamente un nombre nuevo (`_v4`) que perder tiempo esperando a que Meta libere uno viejo.

### `metodo_pago`
- **Variables:** `{{1}}` nombre del cliente · `{{2}}` monto de la cotización
- **Cuerpo:** `🛒 ¡Ya casi terminamos, {{1}}! Para tu pedido de {{2}}, ¿cómo preferís pagar? Elegí la opción que te quede más cómoda.`
- **Ejemplos:** `Juan Pérez, $150.000`
- **Botones:** 3 Quick Reply, en este orden exacto (mapeo fijo en `systemPrompt.ts`, no hay validación en código — ver nota más abajo): `Transferencia` → `transferencia` · `Pago en línea` → `pago_en_linea` · `Contra entrega` → `efectivo_contraentrega`
- **Código:** `src/domains/commerce/preguntarMetodoPago.ts`
- Nota: `buildButtonsComponent` (`adminPanel.ts`) acepta cualquier texto en esos 3 campos — el acoplamiento con el mapeo del prompt es por convención al tipear el formulario, no por validación de código.

### `confirmar_domicilio`
- **Variables:** `{{1}}` número de pedido · `{{2}}` dirección de entrega
- **Cuerpo:** `Antes de alistar tu pedido #{{1}}, confirmanos si la dirección de entrega sigue siendo {{2}}, así seguimos con el despacho.`
- **Ejemplos:** `FM-0001, Cra 45 #12-30, Bogotá`
- **Botones:** 3 Quick Reply — `Confirmar dirección` · `Cambiar temporalmente` (solo este pedido) · `Cambiar permanentemente` (además actualiza el perfil)
- **Código:** `src/domains/commerce/cerrarPedido.ts` (envío automático) y `src/domains/commerce/confirmarDomicilioPedido.ts` (reenvío/confirmación manual); `src/domains/commerce/actualizarDireccionPedido.ts` resuelve los dos botones de cambio (tool `actualizar_direccion_pedido`) — actualiza `orders.delivery_address` siempre y `customers.address` solo si el cliente tocó "Cambiar permanentemente" (mismo criterio que `save_permanently` en `crearPedido.ts`).
- Gate relacionado: `registrarGuia.ts` exige `orders.address_confirmed_at IS NOT NULL` antes de aceptar una guía (migración `0059_orders_domicilio_confirmado.cjs`) — cualquiera de los 3 botones deja esa columna en `now()`.

### `pago_aprobado`
- **Variables:** `{{1}}` número de pedido · `{{2}}` monto pagado
- **Cuerpo:** `🎉 ¡Pago aprobado! Tu pedido #{{1}} por {{2}} ya está confirmado. Estamos alistando todo para enviarlo. Si tenés un momento, contanos cómo te fue:`
- **Ejemplos:** `FM-0001, $150.000`
- **Botones:** 1 URL (`Dejar reseña` → `<origen público del backend>/resena/{{1}}`, variable = token de reseña real; ejemplo para revisión: cualquier texto tipo `abc123`)
- **Código:** `src/domains/commerce/notificarPagoCliente.ts` (`notificarClientePagoAprobado`)
- ⚠️ El dominio del botón debe ser el mismo que `PUBLIC_WEBHOOK_URL` en el entorno donde se cree la plantilla (queda fijo una vez aprobada — cambiarlo después implica recrearla).

### `pago_rechazado`
- **Variables:** `{{1}}` número de pedido · `{{2}}` monto
- **Cuerpo:** `⚠️ Tu pago del pedido #{{1}} por {{2}} no pudo procesarse. Podés intentar de nuevo o elegir otro método. Contanos y lo resolvemos juntos.`
- **Ejemplos:** `FM-0001, $150.000`
- **Botones:** ninguno
- **Código:** `src/domains/commerce/notificarPagoCliente.ts` (`notificarClientePagoRechazado`)

### `pedido_en_camino`
- **Variables:** `{{1}}` número de pedido · `{{2}}` número de guía · `{{3}}` transportadora
- **Cuerpo:** `🚚 ¡Tu pedido #{{1}} ya está en camino! Número de guía: {{2}} con {{3}}. Cualquier novedad, avísanos.`
- **Ejemplos:** `FM-0001, 123456789, Servientrega`
- **Botones:** ninguno
- **Código:** `src/domains/commerce/registrarGuia.ts` (best-effort, con fallback a texto libre)

### `carrito_abandonado`
- **Variables:** `{{1}}` nombre del cliente · `{{2}}` productos de la cotización · `{{3}}` monto total
- **Cuerpo:** `👋 Hola {{1}}, ¿seguís interesado en {{2}}? Vimos tu cotización por {{3}}. Si querés, seguimos con tu pedido. ¡Estamos atentos!`
- **Ejemplos (en orden 1,2,3):** `Juan Pérez, casco integral talla M, $150.000`
- **Botones:** ninguno
- **Código:** `src/jobs/reactivarCotizacionesFrias.ts` (mismo cron horario que `cazadorDeVentas.ts`, cotizaciones sin respuesta hace 20h–7 días)
- Nota de categoría: aunque el resto de las plantillas "utility" ya funcionan con `UTILITY`, esta reengancha una venta parada — Meta suele reclasificar ese contenido como `MARKETING` aunque se envíe como `UTILITY`, y si la rechaza por eso hay que recrearla. Se crea directamente como `MARKETING` para evitar esa vuelta.
- Nota de tono (actualizada 2026-09-06): a diferencia del resto, esta reabre una conversación que quedó fría por días — ya no sigue la regla de "sin saludo": abre con "Hola" a propósito (decisión explícita del negocio, ver "Regla de diseño para el agente" más arriba).

### `pedido_cancelado`
- **Variables:** `{{1}}` número de pedido
- **Cuerpo:** `📢 Tu pedido #{{1}} fue cancelado. Si fue un error o querés hacer un pedido nuevo, escribinos 🙌 ¡Estamos para ayudarte!`
- **Ejemplos:** `FM-0001`
- **Botones:** ninguno
- **Código:** `src/domains/commerce/notificarPedidoCancelado.ts` (llamada desde la tool `cancelar_pedido` y desde `adminPanel.ts`)

### `promocion_general`
No tiene nombre reservado en el código — el botón "Mandar promoción" de Leads lista **cualquier plantilla aprobada de categoría Marketing**, con la cantidad de variables que tenga esa plantilla puntual (el admin tipea los valores al mandarla, `variablesRaw` en `enviarPromocionCliente`). `promocion_general` es simplemente la primera que se creó con ese fin — nada impide crear otras además de esta.
- **Variables:** `{{1}}` nombre de la promo · `{{2}}` % de descuento · `{{3}}` categoría/producto · `{{4}}` fecha límite
- **Cuerpo:** `🔥 ¡{{1}} en ForMotos! {{2}}% de descuento en {{3}} hasta el {{4}}. ¡No te lo pierdas!`
- **Ejemplos:** `Black Friday, 20, cascos, 30/11`
- **Botones:** ninguno
- **Código:** `src/admin/adminPanel.ts` (`enviarPromocionCliente`), envío manual 1 a 1 — sin broadcast por segmento (fuera de alcance a propósito, ver Historial).

## Estado de creación en Meta

Completar esta tabla a medida que se crean/aprueban desde `/admin/plantillas` — es el registro real de trazabilidad (qué existe hoy en Meta, no solo en el código).

| Plantilla | Creada | Aprobada | Fecha | Notas |
|---|---|---|---|---|
| `pedido_confirmado` (nombre original) | ❌ borrada | — | 2026-09-06 | Borrada al intentar recrearla con el cuerpo/botón nuevos; Meta bloqueó recrear con el mismo nombre. No se reintenta — reemplazada, ver `_v3`. |
| `pedido_confirmado_v2` | ❌ borrada | — | 2026-09-06 | Creada bien, pero un bug del script (borraba/recreaba en cada corrida en vez de saltar si ya existía) la borró sin necesidad al correr el script para otra cosa (`promocion_general`). Meta volvió a bloquear el nombre. No se reintenta — reemplazada por `_v3`. Script corregido. |
| `pedido_confirmado_v3` | ✅ | ⬜ | 2026-09-06 | Creada vía script (`scripts/crear-plantillas-2026-09.ts`) con el cuerpo nuevo y el botón "Confirmar y pagar" como Quick Reply. En revisión. |
| `metodo_pago` | ✅ | ⬜ | 2026-09-06 | Creada vía script. En revisión. |
| `confirmar_domicilio` | ✅ | ⬜ | 2026-09-06 | Primer intento rechazado por Meta con error genérico ("Invalid parameter", código 100, sin más detalle); reintentada con los mismos datos, sin cambios, y esta vez se creó bien — probable error transitorio del lado de Meta. En revisión. |
| `pago_aprobado` | ✅ | ⬜ | 2026-09-06 | Creada vía script. Botón "Dejar reseña" con el origin de `PUBLIC_WEBHOOK_URL` vigente en ese momento (túnel de Cloudflare, efímero — si cambia, hay que recrear la plantilla). En revisión. |
| `pago_rechazado` | ✅ | ⬜ | 2026-09-06 | Creada vía script. En revisión. |
| `pedido_en_camino` | ✅ | ⬜ | 2026-09-06 | Creada vía script. En revisión. |
| `carrito_abandonado` | ✅ | ⬜ | 2026-09-06 | Creada vía script, categoría Marketing. En revisión. |
| `pedido_cancelado` | ✅ | ⬜ | 2026-09-06 | Creada vía script. En revisión. |
| `promocion_general` | ✅ | ⬜ | 2026-09-06 | Creada vía script, categoría Marketing. En revisión. |

## Historial de cambios
- **2026-09-06:** `promocion_general` creada en Meta (categoría Marketing, sin botones). Al correr el script para esto, un bug (la sección de `pedido_confirmado_v2` no tenía la misma lógica de "saltar si ya existe" que el resto) la borró sin necesidad, y Meta volvió a bloquear el nombre al reintentar recrearla — igual que había pasado con el nombre original, pero esta vez el mensaje de error decía "less than 1 minute" y siguió bloqueada más de 5 minutos de reintentos (el tiempo que reporta Meta no es confiable). Se creó como `pedido_confirmado_v3` y se corrigió el script para que nunca vuelva a borrar/recrear por accidente (requiere `FORZAR_RECREACION_PEDIDO_CONFIRMADO=1` explícito).
- **2026-09-06:** `metodo_pago`, `pago_aprobado`, `pago_rechazado`, `pedido_en_camino`, `carrito_abandonado` y `pedido_cancelado` creadas en Meta (`scripts/crear-plantillas-2026-09.ts`, reusa `crearPlantilla`/`eliminarPlantilla` de `adminPanel.ts` — mismo flujo que el panel). Al intentar recrear `pedido_confirmado` con el cuerpo/botón nuevos, Meta la borró bien pero **rechazó recrearla con el mismo nombre** ("Se está eliminando el idioma... vuelve a intentarlo en 4 weeks", código 100/2388023) — no documentado en ningún lado hasta pisarlo. Se creó como `pedido_confirmado_v2` en su lugar (mismo cuerpo/botones) y se actualizó `cerrarPedido.ts`/`toolDefinitions.ts` para usar ese nombre.
- **2026-09-06:** revisión de copy de las 7 plantillas restantes (emojis, tono más cercano) y la tool nueva `confirmar_pago_pedido` (`src/domains/commerce/confirmarPagoPedido.ts`) — el botón `Confirmar y pagar` de `pedido_confirmado` deja de ser un link a `formotos.com` (nunca conectado a este backend) y pasa a ser un Quick Reply que resuelve el pago de verdad según `orders.payment_method`: reenvía los datos de transferencia (`datosTransferencia.ts`) o el link de Wompi ya generado (`orders.wompi_payment_link_url`), o avisa que no hay nada que pagar si es contra entrega. Como Meta no tiene edición de plantillas, `pedido_confirmado` se borró y recreó (vuelve a `pending`).
- **2026-09-06:** el mensaje de error de la Graph API (`src/gateway/channels/meta/graph.ts`) ahora prioriza `error_user_msg`/`error_user_title`/`error_data.details` sobre el genérico `error.message` — a raíz de que el primer intento de crear `confirmar_domicilio` solo mostró "Invalid parameter (código 100)", sin pista de la causa real.
- **2026-09-06:** `confirmar_domicilio` pasa de 1 a 3 botones — se agregan `Cambiar temporalmente` (solo ese pedido) y `Cambiar permanentemente` (también actualiza el perfil), con la tool nueva `actualizar_direccion_pedido` (`src/domains/commerce/actualizarDireccionPedido.ts`) resolviéndolos. Como la plantilla todavía no se había creado en Meta, se define directamente con los 3 botones (sin recrear nada).
- **2026-09-03 — PR #96** (`feature/plantillas-meta`): gestión de plantillas desde `/admin/plantillas` + `pedido_confirmado` creada, aprobada y probada en vivo contra un número real, integrada a `cerrar_pedido`/`cancelar_pedido`.
- **2026-09-05 — PR #97** (`feature/plantillas-flujo-completo`, apilado sobre #96): las 7 plantillas restantes + sus disparadores de dominio (`resolveApprovedTemplate.ts`, `preguntarMetodoPago.ts`, `confirmarDomicilioPedido.ts`, `notificarPagoCliente.ts`, `notificarPedidoCancelado.ts`, gate de domicilio en `registrarGuia.ts`, job `reactivarCotizacionesFrias.ts`). Ambos PRs mergeados a `develop` el mismo día.
- **2026-09-05:** texto de `pedido_confirmado` revisado (se saca el saludo inicial) y definición final del cuerpo/variables de las 8 plantillas nuevas — ninguna abre con "Hola", todas asumen continuidad de una conversación ya en curso. Este documento pasa a ser la referencia única (reemplaza la versión pensada para Twilio, nunca implementada).

## Fuera de alcance (a propósito)
- Envío masivo/broadcast por segmento de clientes para promociones — solo envío manual 1 a 1 por ahora.
- Flujo de "actualizar dirección" si el cliente avisa por texto que cambió — por ahora `confirmar_domicilio` solo confirma la que ya hay, o se resuelve a mano desde el panel.
- Revisión manual de transferencia rechazada desde el panel — hoy `pago_rechazado` solo se dispara desde el webhook de Wompi.
