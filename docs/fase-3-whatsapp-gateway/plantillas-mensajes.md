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
El agente (Claude) **nunca decide el texto exacto de una plantilla** — decide *cuándo* corresponde enviarla y con qué variables; el texto en sí está fijo y aprobado, coherente con "el LLM propone, la tool decide" (Fase 1). Ídem para el tono: ninguna plantilla abre con un saludo ("Hola") — todas asumen que continúan una conversación ya en curso, nunca que la abren.

## Catálogo vigente

| Plantilla | Categoría | Se dispara desde | Si no está aprobada |
|---|---|---|---|
| `pedido_confirmado` | Utility | `cerrarPedido.ts` (tool `cerrar_pedido`) | No cierra el pedido con plantilla; `cerrar_pedido` devuelve `plantilla_no_aprobada` sin mandar nada |
| `metodo_pago` | Utility | `preguntarMetodoPago.ts` (tool `preguntar_metodo_pago`) | Ídem, sin fallback de texto libre |
| `confirmar_domicilio` | Utility | `cerrarPedido.ts` (2do envío, best-effort) + `confirmarDomicilioPedido.ts` (reenvío desde el panel) | El cierre del pedido no falla (`domicilio_status: "plantilla_no_aprobada"`); el panel puede reenviarla después o el admin confirma a mano — si no está aprobada tampoco se puede usar `actualizar_direccion_pedido` (depende del mismo envío) |
| `pago_aprobado` | Utility | `notificarPagoCliente.ts` (webhook de Wompi, pago `APPROVED`) | No se manda nada al cliente (los admins sí se enteran, por otro camino) |
| `pago_rechazado` | Utility | `notificarPagoCliente.ts` (webhook de Wompi, pago `DECLINED`/`VOIDED`/`ERROR`) | Ídem |
| `pedido_en_camino` | Utility | `registrarGuia.ts` (al registrar la guía por primera vez) | Cae al texto libre de siempre — sin regresión, solo pierde alcance fuera de la ventana de 24h |
| `carrito_abandonado` | **Marketing** (ver nota) | `reactivarCotizacionesFrias.ts` (cron horario) | La cotización sigue candidata en la próxima corrida (no se marca como intentada) |
| `pedido_cancelado` | Utility | `notificarPedidoCancelado.ts` (tool `cancelar_pedido` y panel) | No se manda nada al cliente |
| *(sin nombre fijo)* — plantilla de promoción | Marketing | Botón "Mandar promoción" en Leads (`enviarPromocionCliente`, `adminPanel.ts`) | No aparece en el selector del panel (solo lista `MARKETING` + `approved`) |

## Detalle por plantilla

### `pedido_confirmado`
- **Variables:** `{{1}}` nombre del cliente · `{{2}}` número de pedido · `{{3}}` monto · `{{4}}` método de entrega
- **Cuerpo:** `Gracias, {{1}}: tu pedido #{{2}} por {{3}} quedó confirmado (entrega: {{4}}). Cualquier cosa, contanos por acá.`
- **Ejemplos:** `Juan Pérez, FM-0001, $150.000, Domicilio`
- **Botones:** 2 Quick Reply (`Agregar productos`, `Cancelar pedido`) + 1 URL (`Confirmar y pagar` → `https://formotos.com/pago/{{1}}`, variable = `order_id` real, no el número público)
- **Código:** `src/domains/commerce/cerrarPedido.ts`

### `metodo_pago`
- **Variables:** `{{1}}` nombre del cliente · `{{2}}` monto de la cotización
- **Cuerpo:** `Ya casi terminamos, {{1}} — para tu pedido por {{2}}, ¿cómo preferís pagar?`
- **Ejemplos:** `Juan Pérez, $150.000`
- **Botones:** 3 Quick Reply, en este orden exacto (mapeo fijo en `systemPrompt.ts`): `Transferencia` → `transferencia` · `Pago en línea` → `pago_en_linea` · `Contra entrega` → `efectivo_contraentrega`
- **Código:** `src/domains/commerce/preguntarMetodoPago.ts`

### `confirmar_domicilio`
- **Variables:** `{{1}}` número de pedido · `{{2}}` dirección de entrega
- **Cuerpo:** `Antes de alistar tu pedido #{{1}}, confirmanos si la dirección de entrega sigue siendo {{2}}, así seguimos con el despacho.`
- **Ejemplos:** `FM-0001, Cra 45 #12-30, Bogotá`
- **Botones:** 3 Quick Reply — `Confirmar dirección` · `Cambiar temporalmente` (solo este pedido) · `Cambiar permanentemente` (además actualiza el perfil)
- **Código:** `src/domains/commerce/cerrarPedido.ts` (envío automático) y `src/domains/commerce/confirmarDomicilioPedido.ts` (reenvío/confirmación manual); `src/domains/commerce/actualizarDireccionPedido.ts` resuelve los dos botones de cambio (tool `actualizar_direccion_pedido`) — actualiza `orders.delivery_address` siempre y `customers.address` solo si el cliente tocó "Cambiar permanentemente" (mismo criterio que `save_permanently` en `crearPedido.ts`).
- Gate relacionado: `registrarGuia.ts` exige `orders.address_confirmed_at IS NOT NULL` antes de aceptar una guía (migración `0059_orders_domicilio_confirmado.cjs`) — cualquiera de los 3 botones deja esa columna en `now()`.

### `pago_aprobado`
- **Variables:** `{{1}}` número de pedido · `{{2}}` monto pagado
- **Cuerpo:** `Tu pago del pedido #{{1}} por {{2}} fue aprobado 🎉 Ya estamos alistando todo. Contanos cómo te fue:`
- **Ejemplos:** `FM-0001, $150.000`
- **Botones:** 1 URL (`Dejar reseña` → `<origen público del backend>/resena/{{1}}`, variable = token de reseña real; ejemplo para revisión: cualquier texto tipo `abc123`)
- **Código:** `src/domains/commerce/notificarPagoCliente.ts` (`notificarClientePagoAprobado`)
- ⚠️ El dominio del botón debe ser el mismo que `PUBLIC_WEBHOOK_URL` en el entorno donde se cree la plantilla (queda fijo una vez aprobada — cambiarlo después implica recrearla).

### `pago_rechazado`
- **Variables:** `{{1}}` número de pedido · `{{2}}` monto
- **Cuerpo:** `Tu pago del pedido #{{1}} por {{2}} no pudo procesarse. Podés intentar de nuevo o elegir otro método — contanos y seguimos.`
- **Ejemplos:** `FM-0001, $150.000`
- **Botones:** ninguno
- **Código:** `src/domains/commerce/notificarPagoCliente.ts` (`notificarClientePagoRechazado`)

### `pedido_en_camino`
- **Variables:** `{{1}}` número de pedido · `{{2}}` número de guía · `{{3}}` transportadora
- **Cuerpo:** `Tu pedido #{{1}} ya está en camino 🚚 Guía {{2}}, con {{3}} — cualquier novedad, contanos.`
- **Ejemplos:** `FM-0001, 123456789, Servientrega`
- **Botones:** ninguno
- **Código:** `src/domains/commerce/registrarGuia.ts` (best-effort, con fallback a texto libre)

### `carrito_abandonado`
- **Variables:** `{{1}}` nombre del cliente · `{{2}}` productos de la cotización · `{{3}}` monto total
- **Cuerpo:** `¿Seguís interesado/a en {{2}}, {{1}}? Vimos tu cotización por {{3}} — contanos y seguimos con tu pedido.`
- **Ejemplos (en orden 1,2,3):** `Juan Pérez, casco integral talla M, $150.000`
- **Botones:** ninguno
- **Código:** `src/jobs/reactivarCotizacionesFrias.ts` (mismo cron horario que `cazadorDeVentas.ts`, cotizaciones sin respuesta hace 20h–7 días)
- Nota de categoría: aunque el resto de las plantillas "utility" ya funcionan con `UTILITY`, esta reengancha una venta parada — Meta suele reclasificar ese contenido como `MARKETING` aunque se envíe como `UTILITY`, y si la rechaza por eso hay que recrearla. Se crea directamente como `MARKETING` para evitar esa vuelta.
- Nota de tono: a diferencia del resto, esta reabre una conversación que quedó fría por días — se le aplicó la misma regla de "sin saludo" por consistencia, aunque acá sí podría discutirse un saludo liviano.

### `pedido_cancelado`
- **Variables:** `{{1}}` número de pedido
- **Cuerpo:** `Tu pedido #{{1}} fue cancelado. Si fue un error o querés hacer un pedido nuevo, escribinos 🙌`
- **Ejemplos:** `FM-0001`
- **Botones:** ninguno
- **Código:** `src/domains/commerce/notificarPedidoCancelado.ts` (llamada desde la tool `cancelar_pedido` y desde `adminPanel.ts`)

### Plantilla de promoción (sin nombre fijo)
No tiene nombre reservado en el código — el botón "Mandar promoción" de Leads lista **cualquier plantilla aprobada de categoría Marketing**, con la cantidad de variables que tenga esa plantilla puntual. Punto de partida sugerido:
- **Variables:** `{{1}}` nombre de la promo · `{{2}}` % de descuento · `{{3}}` categoría/producto · `{{4}}` fecha límite
- **Cuerpo:** `¡{{1}} en ForMotos! {{2}}% de descuento en {{3}} hasta el {{4}}, aprovechá.`
- **Ejemplos:** `Black Friday, 20, cascos, 30/11`
- **Botones:** ninguno (opcional un enlace al catálogo)
- **Código:** `src/admin/adminPanel.ts` (`enviarPromocionCliente`), envío manual 1 a 1 — sin broadcast por segmento (fuera de alcance a propósito, ver Historial).

## Estado de creación en Meta

Completar esta tabla a medida que se crean/aprueban desde `/admin/plantillas` — es el registro real de trazabilidad (qué existe hoy en Meta, no solo en el código).

| Plantilla | Creada | Aprobada | Fecha | Notas |
|---|---|---|---|---|
| `pedido_confirmado` | ✅ | ✅ | 2026-09-03 | En revisión otra vez mientras se aplica el texto sin saludo de este documento |
| `metodo_pago` | ⬜ | ⬜ | | |
| `confirmar_domicilio` | ⬜ | ⬜ | | |
| `pago_aprobado` | ⬜ | ⬜ | | |
| `pago_rechazado` | ⬜ | ⬜ | | |
| `pedido_en_camino` | ⬜ | ⬜ | | |
| `carrito_abandonado` | ⬜ | ⬜ | | |
| `pedido_cancelado` | ⬜ | ⬜ | | |
| Promoción (nombre a definir) | ⬜ | ⬜ | | |

## Historial de cambios
- **2026-09-06:** `confirmar_domicilio` pasa de 1 a 3 botones — se agregan `Cambiar temporalmente` (solo ese pedido) y `Cambiar permanentemente` (también actualiza el perfil), con la tool nueva `actualizar_direccion_pedido` (`src/domains/commerce/actualizarDireccionPedido.ts`) resolviéndolos. Como la plantilla todavía no se había creado en Meta, se define directamente con los 3 botones (sin recrear nada).
- **2026-09-03 — PR #96** (`feature/plantillas-meta`): gestión de plantillas desde `/admin/plantillas` + `pedido_confirmado` creada, aprobada y probada en vivo contra un número real, integrada a `cerrar_pedido`/`cancelar_pedido`.
- **2026-09-05 — PR #97** (`feature/plantillas-flujo-completo`, apilado sobre #96): las 7 plantillas restantes + sus disparadores de dominio (`resolveApprovedTemplate.ts`, `preguntarMetodoPago.ts`, `confirmarDomicilioPedido.ts`, `notificarPagoCliente.ts`, `notificarPedidoCancelado.ts`, gate de domicilio en `registrarGuia.ts`, job `reactivarCotizacionesFrias.ts`). Ambos PRs mergeados a `develop` el mismo día.
- **2026-09-05:** texto de `pedido_confirmado` revisado (se saca el saludo inicial) y definición final del cuerpo/variables de las 8 plantillas nuevas — ninguna abre con "Hola", todas asumen continuidad de una conversación ya en curso. Este documento pasa a ser la referencia única (reemplaza la versión pensada para Twilio, nunca implementada).

## Fuera de alcance (a propósito)
- Envío masivo/broadcast por segmento de clientes para promociones — solo envío manual 1 a 1 por ahora.
- Flujo de "actualizar dirección" si el cliente avisa por texto que cambió — por ahora `confirmar_domicilio` solo confirma la que ya hay, o se resuelve a mano desde el panel.
- Revisión manual de transferencia rechazada desde el panel — hoy `pago_rechazado` solo se dispara desde el webhook de Wompi.
