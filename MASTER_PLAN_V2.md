# Plan Maestro v2 — Agent Sale (Fases 13+)

## Contexto

Este documento es la continuación de [`MASTER_PLAN.md`](./MASTER_PLAN.md) (Fases 0-12, todas diseñadas; 0-9 y la mayor parte de 11-12 ya implementadas — ver el hallazgo de la sección "Estado real verificado" más abajo). Nace de [`PROPUESTA_V2.md`](./PROPUESTA_V2.md), el encargo de Rob para profundizar gestión administrativa, pedidos/clientes, tickets, promociones, personalización del asistente y operación multicanal.

**Vigente durante todo este documento: instrucción 5 de `PROPUESTA_V2.md`.** Nada de `MASTER_PLAN.md` ni de `docs/fase-0-*` a `docs/fase-12-*` se edita en esta etapa. Este documento y las carpetas `docs/fase-13-*` en adelante son la única superficie de escritura de v2. Cuando el negocio confirme que v2 pasa a producción, este documento se fusiona con `MASTER_PLAN.md` (numeración continua, sin rastro de "v1"/"v2") siguiendo el criterio de la sección 5 de `PROPUESTA_V2.md`.

Las decisiones de arquitectura de v1 que este documento **mantiene sin cambios** (no se reabren): monolito modular, tool calling con validación estricta contra Postgres, pgvector dentro de Postgres, `node-cron` en proceso para jobs programados (ADR-018), escalamiento por máquina de estados explícita, idempotencia/auditoría/observabilidad desde el diseño. Toda fase nueva de v2 se construye sobre estas mismas decisiones.

**Corrección post-Fase 13 (ADR-032, 2026-08-03):** este documento originalmente listaba "RLS multi-tenant desde la primera tabla" como decisión que no se reabre. Se reabrió: al implementar la Fase 13 quedó en evidencia que agent-sale sirve un solo negocio (ForMotos), no varios, y el propio código ya lo asumía en varios puntos. ADR-032 supera formalmente a ADR-004 — se retiró RLS y `tenant_id` de las 17 tablas de negocio + 4 de tokens; `tenants` se renombró a `settings` (tabla singleton). **Toda mención a "por tenant"/`tenantId` en las Fases 14-22 de este documento (redactadas antes de ADR-032) queda obsoleta** — las fases siguientes parten del esquema mono-tenant ya vigente, sin columna `tenant_id` en ninguna tabla nueva.

---

## Estado real verificado (corrige una premisa de `PROPUESTA_V2.md`)

`PROPUESTA_V2.md` (sección 2, tomando el estado literal de `docs/fase-11-panel-admin-dashboard/README.md`) afirma que **"11.4 y 11.5 siguen en diseño, sin implementar"**. Se verificó contra el historial real de `git log --all --merges` y no solo contra la documentación:

- PR #37 `feature/impl-fase11-4-config-llm` — *"Implementa Fase 11.4 — Configuración: kill-switch + modelo de IA configurable (BYOK)"* — mergeado a `develop`.
- PR #38/#39/#40 (`impl-tono-estilo-comportamiento`, `impl-velocidad-respuesta`, `impl-cerebro-ruteo-automatico`) — Tono/Estilo/Velocidad/Ruteo automático (ADR-021/022/023) — mergeados.
- PR #41 `feature/impl-analitica-costos` — *"Agregar analítica de costos de LLM (Fase 11.5)"* — mergeado.
- Código real presente y con tests: `src/orchestrator/behaviorConfig.ts`, `src/orchestrator/toneBlocks.ts`, `src/orchestrator/difficultyRouting.ts`, migraciones `0020`-`0024` (`tenants_llm_config_bot_paused`, `tenants_behavior_config`, `tenants_llm_routing_mode`, `llm_usage`, `tenants_report_recipient`), rutas `/admin/:tenantId/configuracion/*` y `/admin/:tenantId/analitica` en `src/gateway/server.ts`. Tests: `tests/unit/orchestrator/behaviorConfig.test.ts`, `tests/unit/orchestrator/toneBlocks.test.ts`, `tests/unit/orchestrator/llm/difficultyRouting.test.ts`, `tests/integration/gateway/admin.test.ts`.

**Conclusión:** Fase 11.4 y 11.5 están implementadas, probadas y mergeadas a `develop` — el README de Fase 11 quedó desactualizado (no se actualizó el encabezado de estado tras los merges de esos PRs). Por instrucción explícita de Rob, **no se corrige `docs/fase-11-panel-admin-dashboard/README.md` en esta etapa** (no tocar documentación v1 mientras v2 está en diseño); queda anotado aquí para que el equipo actualice ese estado cuando corresponda, y las fases 17/20/21 de este documento parten de la base real (implementada), no de la que describe el README desactualizado.

Esto también cambia el punto de partida de varios bloques de la propuesta: el bloque 3.8 no reabre un "diseño pendiente" de tono, sino que **extiende** un mecanismo ya implementado y en producción (ADR-021, con verificación de cache hit real documentada en esa misma ADR).

---

## Relación de cada bloque de `PROPUESTA_V2.md` §3 con v1

| Bloque | Relación con v1 | Fase v2 |
|---|---|---|
| 3.1 Autenticación y colaboradores | Reabre el disparador que **ADR-015** dejó explícito para la Fase 10 (identidad real). No se ejecuta dentro de la Fase 10 original (ver justificación en Fase 13) — fase propia. | **13** |
| 3.2 Flujo de pedidos y datos de cliente | Extiende `docs/fase-6-dominio-comercial/flujo-cotizacion-pedido.md` y `customers` (`migrations/0003_customers.cjs`). Nuevo: captura progresiva, edición temporal/permanente, pedido abierto que acumula ítems. | **15** |
| 3.3 Estado, seguimiento y pagos | Extiende **ADR-024** (`orders.payment_status`, Wompi) y `orders` (`migrations/0007`, `0030`-`0032`). Nuevo: número público de pedido, guía/transportadora, cierre automático a 5 días. | **16** |
| 3.4 Notificaciones administrativas y reportes | Extiende `src/jobs/dailyReport.ts` (Fase 12.2) y `tenants.report_recipient_phone` (ADR-018/024). Nuevo: multi-destinatario por permiso, requiere 3.1. | **13** |
| 3.5 Tickets integrados al panel | Choca parcialmente con **Fase 7** (`docs/fase-7-escalamiento-humano/vista-asesor.md`, `handoff-queue.md`): el flujo de acción hoy vive en `POST /asesor/:token/tomar\|resolver`, no en el panel — la Fase 11.2 lo dejó explícitamente fuera (`conversaciones-leads-tickets.md`, línea final). Requiere ADR nueva (convive vs. reemplaza). | **18** |
| 3.6 Panel de conversaciones mejorado | Extiende Fase 11.2 (`conversaciones-leads-tickets.md`). El "canal de origen" depende de que exista más de un canal (Fase 19). | **18** |
| 3.7 Motor de promociones avanzado | Extiende `docs/fase-6-dominio-comercial/motor-promociones.md` — la regla **"no se combinan promociones, se confirmó con ForMotos"** se mantiene; las nuevas dimensiones (aliado/categoría/campaña) se sencillan como filtros de elegibilidad adicionales dentro del mismo mecanismo de "elegir la de mayor beneficio", no como un mecanismo de stacking nuevo (ver ADR-027). Requiere el catálogo de Fase 14. | **17** |
| 3.8 Voz de marca, RAG, parametrización | Extiende **ADR-021** (ya implementada, ver hallazgo arriba) con un tercer bloque/breakpoint de `system prompt`. El "bug reportado" se trata como hallazgo a reproducir, no como brecha asumida (ver Fase 20). | **20** |
| 3.9 Enlaces amigables y templates interactivos | Extiende `src/gateway/messageSplitter.ts`, `extractPaymentLinkUrl` (ADR-024) y las plantillas de WhatsApp de **ADR-019**. Nuevo: templates de botones para cierre de pedido. | **21** |
| 3.10 Esquema ampliado (general) | Extiende `docs/fase-1-arquitectura/modelo-datos.md`. Distribuido: tabla de administradores → Fase 13; datos progresivos de cliente → Fase 15; elegibilidad de promoción → Fase 17. | **13 / 15 / 17** |
| 3.10.1 Catálogo (aliados/categorías/variantes) | Es, en palabras de la propia propuesta, "la parte de mayor cambio estructural". Reescribe `products` (`migrations/0005`) y los contratos `consultar_inventario`/`generar_cotizacion`/`crear_pedido` de `docs/fase-1-arquitectura/contratos-tools.md`. Fase propia por el tamaño del cambio y porque todo lo demás de catálogo/pedidos/promociones depende de este esquema. | **14** |
| 3.11 Multicanal (Instagram/Meta) | Completamente nuevo — no hay equivalente en Fase 3 (`docs/fase-3-whatsapp-gateway/`), que es monocanal por diseño. Gateway adicional con contrato propio, no una extensión del webhook de Twilio. | **19** |
| 3.12 Reseñas y redes sociales | Extiende `src/reviews/reviewView.ts` (Fase 12.2). Menor esfuerzo, sin choque de ADR. | **22** |
| 3.13 Mejoras responsive/UX transversales | Retoma explícitamente el pendiente ya anotado en `docs/fase-11-panel-admin-dashboard/README.md#pendiente-rediseño-responsive-del-contenido`. No es nuevo — es deuda de v1 que v2 cierra. | **22** |

---

## Agrupación de fases: por qué 10 fases y no 13 bloques 1:1

`PROPUESTA_V2.md` autoriza agrupar o dividir bloques si la dependencia técnica real lo justifica. Se agrupó así:

- **13 = 3.1 + 3.4**: ambas dependen del mismo subsistema nuevo (identidad/roles); 3.4 necesita el modelo de permisos de 3.1 para saber a quién notificar.
- **14 = 3.10.1 sola**: por tamaño (reescribe contratos de tools de Fase 1) y porque 15, 16 y 17 dependen de que `product_variants`/`allies`/`product_categories` ya existan — hacerla de último o mezclada habría forzado una segunda migración de `order_items`/`quote_items`.
- **15 y 16 se separaron** aunque ambas tocan `orders`: 3.2 es superficie conversacional (el LLM pregunta/confirma datos antes de crear el pedido) y 3.3 es superficie de backend/webhooks (Wompi, jobs de cierre automático, notificación de guía) — equipos y momentos de prueba distintos, con 16 dependiendo de que 15 ya exista.
- **17 = 3.7 sola**: depende de 14 (elegibilidad por aliado/categoría) y de 15/16 (clasificación de cliente necesita historial de pedidos) — no puede ir antes que ninguna de las dos.
- **18 = 3.5 + 3.6**: ambas mejoran la misma vista del panel (Conversaciones) y comparten la acción "tomar ticket sin salir de la vista" pedida en 3.6.
- **19 = 3.11 sola**: mayor esfuerzo estructural del conjunto, gateway independiente — no bloquea ni depende de 13-18, se puede paralelizar.
- **20 = 3.8 sola**: extiende un mecanismo (ADR-021) que ya tiene su propia complejidad de caching; mezclarla con otra fase habría diluido el diagnóstico del bug reportado.
- **21 = 3.9 sola**: depende de 16 (necesita que el pedido tenga estados/botones que ofrecer) pero es una capa de presentación, no de datos — separable.
- **22 = 3.12 + 3.13**: ambas son cierre visual/UX de baja complejidad de datos, mejor hacerlas al final cuando ya existen todas las pantallas nuevas que el rediseño responsive debe cubrir.

**Orden recomendado de ejecución:** 13 → 14 → 15 → 16 → 17, en secuencia estricta (cada una depende de la anterior). 18, 19, 20 pueden ejecutarse en paralelo entre sí y en paralelo con 14-17 (no comparten esquema ni código base), igual que v1 permitió paralelizar Fase 11/12 frente a la Fase 10. 21 depende de 16. 22 va al final, cuando el resto de las pantallas de v2 ya existen.

---

## Fase 13 — Autenticación Real, Roles de Colaborador y Notificaciones Administrativas — ✅ COMPLETA (mergeada a `develop`, PRs #52/#53, 2026-08-03)

**Objetivo:** Reemplazar el Basic Auth global (ADR-015) por login individual con sesiones, una tabla de administradores con permisos granulares, y extender las notificaciones/reportes existentes (Fase 12.2, ADR-024) para que respeten esos permisos en vez de un único destinatario fijo.

**Entregables:**
- Tabla `admins`: email, `username` (único, 5-32 caracteres), `avatar_data` (data URL base64), `phone` (único), hash de contraseña, rol (`master`/`colaborador`), activo/inactivo.
- Tabla `admin_permissions` (resuelto en ADR-025: tabla propia con columnas booleanas, no `jsonb`): `recibe_reporte_diario`, `recibe_tickets`, `recibe_notificacion_pagos`.
- Login con sesión (cookie firmada) en `/login`, reemplazando el Basic Auth global. **Ampliado sobre el alcance original**: login combinado por username O correo (`findAdminByUsernameOrEmail`), no solo correo.
- Sección "Colaboradores" (`/admin/colaboradores`, sin `tenantId` desde ADR-032): el administrador *master* crea/activa/desactiva cuentas y asigna permisos vía un `<dialog>` nativo; tabla con columna "Acciones" (Guardar permisos + Activar/Desactivar coloreado).
- `dailyReport.ts` y las notificaciones de pago de `wompiWebhookHandler.ts` leen `resolveNotificationRecipients()` (lista de administradores con el permiso correspondiente), con `settings.report_recipient_phone` como fallback solo si ningún admin tiene el permiso marcado.
- ADR-025: alcance de autenticación real y modelo de permisos.
- **Fuera del alcance original, agregado a pedido explícito tras probar lo anterior** ("Fase 13 v2"): sección "Perfil" (`/admin/perfil`) para editar username/correo/teléfono/avatar propios (master y colaborador por igual); menú de cuenta en el pie del nav rail ("Editar perfil"/"Cerrar sesión"); validación en tiempo real de username/email/password + chequeo de disponibilidad de username al salir del campo; teléfono como selector de prefijo de país + número (Colombia por defecto); "Reporte del asistente" parametrizable (diario/semanal/mensual/personalizado, en vez de fijo diario). Ver [[project_retiro_multitenancy_perfil]] para el detalle completo.
- **No estaba planeado y se ejecutó dentro de esta misma rama de trabajo**: retiro completo de multi-tenancy (ADR-032, ver corrección al inicio de este documento) — surgió al implementar el login (`/admin/:tenantId/login` no tenía sentido para un solo negocio).

**Dependencias:** Ninguna de v2 (fase base). De v1: reabre el punto que **ADR-015** dejó pendiente para "la Fase 10 real".

**Riesgos:** Migrar el hook de Basic Auth sin dejar una ventana sin protección (`server.ts:59-69` debe reemplazarse atómicamente, no en paralelo con el mecanismo viejo); recuperación de contraseña fuera de alcance inicial si no se define un canal de envío (email no existe hoy en el proyecto, WhatsApp no es apto para credenciales) — debe resolverse en la ADR, no dejarse implícito.

**Estimación:** 3 semanas.

**Definición de terminado:**
- [x] Ningún acceso a `/admin/*` funciona ya con la credencial Basic Auth global; login individual obligatorio.
- [x] Un administrador *master* puede desactivar a un colaborador y esa cuenta pierde acceso de inmediato (`session.ts` valida `admins.active` en cada request contra la fila fresca, no solo al momento del login).
- [x] El reporte diario y la notificación de pago aprobado llegan solo a los administradores con el permiso correspondiente activo (`resolveNotificationRecipients`, con tests de integración en `dailyReport.test.ts` y `wompiWebhook.test.ts`).

### Nota de alcance frente a la Fase 10 original

Esta fase **no se ejecuta como parte de la Fase 10** de `MASTER_PLAN.md` (prueba de carga, runbook de onboarding, escalado de infraestructura) — son entregables de infraestructura que no han empezado y no dependen de identidad. Ejecutarlos juntos retrasaría la autenticación (que el negocio necesita ya, con colaboradores reales) esperando trabajo de carga/infra no relacionado. La Fase 10 original queda intacta y pendiente de iniciar quien el negocio lo priorice; ADR-025 documenta esta separación explícitamente.

---

## Fase 14 — Esquema de Catálogo Extendido (Aliados, Categorías Jerárquicas, Variantes)

**Objetivo:** Reemplazar `products.category` (texto plano) por un árbol de categorías de profundidad libre, introducir `allies` como entidad propia, y separar el producto genérico de sus variantes concretas (SKU/precio/stock), migrando los contratos de las tools que hoy referencian `product_id` directamente.

**Entregables:**
- Tabla `allies` (`id`, `name`, `contact_info`, `active`) — sin `tenant_id` (ADR-032, ver corrección al inicio de este documento).
- Tabla `product_categories` auto-referenciada (`parent_id`), con sección nueva en el panel para administrar el árbol sin tocar código.
- Tabla `product_variants` (`product_id`, `sku`, `attributes jsonb`, `price`, `active`); `products` pierde `sku`/`price` propios y gana `ally_id`, `category_id`, `has_variants`.
- Migración de `inventory.product_id`, `quote_items.product_id`, `order_items.product_id` → `*.variant_id`, con script de backfill (todo producto existente recibe una variante "default" sin atributos, preservando SKU/precio/stock actuales — cero pérdida de datos).
- Contratos de tools actualizados en `docs/fase-1-arquitectura/contratos-tools.md`: `consultar_inventario`, `generar_cotizacion`, `crear_pedido` aceptan/devuelven `variant_id` en vez de (o adicional a) `product_id`.
- Comportamiento nuevo del agente: preguntar talla/color cuando un producto tiene más de una variante activa, antes de cotizar.
- ADR-026: esquema de catálogo extendido y migración de contratos a `variant_id`.

**Dependencias:** Ninguna de v2. De v1: reescribe Fase 1 (`modelo-datos.md`, `contratos-tools.md`) y toca la implementación de Fase 5 (`consultar_inventario`) y Fase 6 (`generar_cotizacion`, `crear_pedido`).

**Riesgos:** Es la migración de mayor riesgo de todo v2 — toca 3 tablas con datos reales si el catálogo de ForMotos ya está cargado (ver pendiente #5 de `pendientes-pre-piloto.md` en la sección de pendientes más abajo: si el catálogo real ya se cargó bajo el esquema viejo, esta fase debe incluir el backfill antes de cualquier otra fase de v2 que dependa de `variant_id`); el LLM debe manejar la nueva pregunta de talla/color sin degradar el "camino feliz" ya validado en Fase 0; una categoría con profundidad excesiva (más de 5-6 niveles) podría hacer lenta la reconstrucción de ruta por `parent_id` — mitigar con una vista materializada o límite práctico de niveles si el volumen real lo justifica.

**Estimación:** 4 semanas.

**Definición de terminado:** ✅ completa (PRs #54 y #55, 2026-08-03) — ver [[project_fase14_catalogo_extendido]] en memoria del proyecto para el detalle completo.
- [x] Los 100 productos/104 variantes de prueba de `scripts/seed-catalogo-prueba.ts` (reescrito, arregla de paso un bug preexistente de `tenant_id`) migrados a `products`/`product_variants`/`product_categories`, con el caso real de 4 niveles de categoría ("Para motos › Otros para motos › Iluminación › Exploradoras") verificado.
- [x] `consultar_inventario`, `generar_cotizacion` y `crear_pedido` operando sobre `variant_id`; el system prompt instruye preguntar la variante cuando hay ambigüedad, verificado manualmente contra un producto real con 3 variantes de talla.
- [x] Panel admin (`/admin/categorias`, `/admin/aliados`) permite crear/editar/activar-desactivar nodos del árbol y aliados, marcar categorías complementarias (reemplaza el mapa hardcodeado de `recomendarProducto.ts`), y asignar aliado/categoría a un producto existente desde `/admin/productos` — sin ningún cambio de código, verificado end-to-end.

---

## Fase 15 — Datos de Cliente y Flujo de Pedidos Extendido

**Objetivo:** Que el asistente capture y confirme progresivamente dirección, cédula y nombre completo del cliente al cerrar un pedido, permita cambios temporales o permanentes, y que un pedido abierto pueda recibir productos adicionales sin crear un pedido nuevo.

**Entregables:**
- `customers` extendida: `address`, `id_document`, `full_name`, `municipality`, `city` (nullable, captura progresiva — no se piden todos de una vez si ya existen).
- Comportamiento del agente: al confirmar pedido, si falta algún dato obligatorio, se solicita y confirma antes de continuar; si ya existe, se muestra para confirmar/cambiar (temporal = solo ese pedido, permanente = actualiza `customers`).
- `orders.status` gana el estado `abierto` (o se reutiliza `draft` de `quotes` extendiéndolo a `orders` — a decidir en implementación): mientras un pedido está `abierto`/sin pago, `crear_pedido`/`agregar_item_pedido` (tool nueva o extensión de `generar_cotizacion`) puede seguir sumando `order_items` sobre el mismo `order_id`.
- Plantilla de WhatsApp (o mecanismo de botones, ver Fase 21) para la confirmación binaria "¿los datos siguen siendo los mismos?".

**Dependencias:** Fase 14 (para que los nuevos `order_items` que se agreguen a un pedido abierto ya referencien `variant_id` y no requieran una segunda migración).

**Riesgos:** Permitir agregar ítems a un pedido ya "confirmado" con el cliente puede chocar con el principio de idempotencia de `crear_pedido` (`docs/fase-1-arquitectura/contratos-tools.md`) — debe definirse si "agregar producto" es una tool nueva con su propia idempotency key o una reapertura explícita del `quote_id` original; dato de cédula es información sensible — revisar si aplica alguna consideración de protección de datos personales antes de almacenarla en texto plano.

**Estimación:** 3 semanas.

**Definición de terminado:**
- [ ] Un cliente nuevo (sin `customers.address`) recibe la solicitud de datos antes de que el pedido se confirme; uno existente ve sus datos y puede confirmarlos o cambiarlos.
- [ ] Un pedido `abierto` recibe un producto adicional sin generar un segundo `order_id`, verificado con un caso de prueba de punta a punta.
- [ ] Cambio "temporal" no persiste en `customers`; cambio "permanente" sí, verificado contra la base tras la conversación.

---

## Fase 16 — Estado de Pedido, Pagos y Logística

**Objetivo:** Cerrar el ciclo de vida del pedido después de creado: sincronizar el estado real de Wompi al pedido visible en el panel, asignar un número público de seguimiento, cerrar automáticamente los pedidos pendientes sin pago a los 5 días, y registrar/notificar guía de envío.

**Entregables:**
- `orders.public_order_number` (secuencial o legible, ej. `FM-0001`), expuesto al cliente para que pueda preguntar su estado por WhatsApp.
- `orders.tracking_number`, `orders.carrier`; al registrarse desde el panel, se dispara notificación automática de WhatsApp al cliente (reutiliza el mismo patrón de envío proactivo dentro de ventana de 24h que ya usa `dailyReport.ts`/`cazadorDeVentas.ts`, ver ADR-018/019).
- Job programado nuevo (mismo patrón `node-cron` de ADR-018): cierra a `cancelado`/`expirado` los pedidos con `payment_status = 'pendiente'` con más de 5 días de antigüedad.
- Notificación al administrador (vía permisos de Fase 13) cuando `orders.payment_status` pasa a `'pagado'` — ya existe el mecanismo base en ADR-024 (notifica a `report_recipient_phone`); esta fase lo redirige a la lista de administradores con el permiso correspondiente.
- Vista de estado de pedido consultable por el cliente (por número público, vía WhatsApp: el cliente escribe su número de pedido y el agente responde el estado).

**Dependencias:** Fase 15 (mismo dominio de `orders`, evita dos rondas de migración sobre la misma tabla). De v1: extiende ADR-024 (Wompi) y el patrón de jobs de ADR-018.

**Riesgos:** El cierre automático a 5 días debe excluir explícitamente pedidos con `payment_method` distinto de `pago_en_linea` (transferencia/efectivo/tarjeta no tienen verificación digital y hoy nacen `payment_status = 'pagado'` por diseño de ADR-024 — no deben cerrarse por "falta de pago" que nunca se esperó verificar); doble notificación si el pago se confirma justo en el borde de los 5 días (mitigar con el mismo criterio idempotente que ya usa el webhook de Wompi, `WHERE payment_status = 'pendiente'`).

**Estimación:** 2-3 semanas.

**Definición de terminado:**
- [ ] Un pedido con `pago_en_linea` pendiente por 5+ días pasa a `cancelado`/`expirado` automáticamente, verificado con un caso de prueba con fecha adelantada.
- [ ] El cliente puede preguntar "¿cómo va mi pedido FM-0001?" y el agente responde el estado real leyendo `orders`.
- [ ] Registrar una guía desde el panel dispara la notificación de WhatsApp al cliente correcto, verificado end-to-end.

---

## Fase 17 — Motor de Promociones Avanzado y Clasificación de Clientes

**Objetivo:** Extender `aplicar_promocion` para evaluar elegibilidad por aliado, categoría/subcategoría, producto puntual y campaña (con restricción de una aplicación por cliente), incorporando una clasificación de cliente (nuevo/recurrente/fiel) sin romper la regla ya confirmada con ForMotos de que las promociones no se combinan.

**Entregables:**
- `promotions` gana columnas de elegibilidad: `ally_id`, `category_id` (con flag de "incluir hijas"), `product_id`/`variant_id` — nullable, sin restricción = aplica a todo el catálogo (comportamiento actual preservado).
- Nuevo `kind: "campaña"` en `promotions.rules` (jsonb), con `once_per_customer: true` y una tabla de auditoría (`promotion_redemptions` o reutilizar `audit_log`) para no volver a aplicarla al mismo cliente.
- `customers.segment` (o tabla derivada, a decidir en ADR-027) calculado desde el historial real de `orders` (nuevo = 0 pedidos, recurrente = 2+, fiel = umbral a definir con el negocio) — no un campo editable a mano, se deriva.
- El motor sigue **"la de mayor beneficio, sin combinar"** como regla final entre todas las promociones elegibles (temporada, volumen, aliado, categoría, campaña) — las nuevas dimensiones filtran el conjunto de candidatas, no apilan descuentos.
- Comunicación proactiva: el agente menciona la promoción aplicable al detectar interés en una categoría/producto con descuento activo, no solo al cierre del pedido (cambio de comportamiento en el orquestador, no solo en la tool).
- ADR-027: reglas de elegibilidad multi-dimensión y clasificación de cliente, documentando explícitamente que "no combinar" se mantiene.

**Dependencias:** Fase 14 (`ally_id`/`category_id` deben existir), Fase 15/16 (clasificación de cliente necesita historial de `orders` ya estable).

**Riesgos:** Comunicar la promoción "proactivamente" puede chocar con el guardrail de no inventar descuentos si el orquestador la menciona antes de que la tool la confirme — debe seguir siendo la tool quien calcule, el LLM solo la anuncia después de una llamada real a `aplicar_promocion`, no antes; la clasificación automática de cliente puede generar disputas de negocio ("¿por qué no soy 'fiel' todavía?") — el umbral debe ser configurable por tenant, no hardcodeado, y validado con ForMotos antes de producción (mismo criterio que el umbral de "monto alto" de Fase 7, todavía pendiente de validación real).

**Estimación:** 3-4 semanas.

**Definición de terminado:**
- [ ] Una promoción exclusiva de un aliado (ej. "Ramos", 10%) solo aplica a productos de ese aliado, verificado con un producto de otro aliado en la misma cotización.
- [ ] Una promoción de campaña con `once_per_customer` no se vuelve a aplicar al mismo cliente en una segunda conversación.
- [ ] El agente menciona una promoción activa al detectar interés en la categoría correspondiente, antes de llegar al cierre del pedido, en al menos un escenario de prueba del golden set de la Fase 9.

---

## Fase 18 — Tickets y Conversaciones Accionables en el Panel

**Objetivo:** Mover la acción de tomar/resolver tickets del flujo por token (`POST /asesor/:token/tomar|resolver`, Fase 7) a una sección del panel, y ampliar la vista de Conversaciones (Fase 11.2) con pausa puntual por conversación, acción de tomar ticket sin salir de la vista, y visualización legible en vez de JSON crudo.

**Entregables:**
- Sección `/admin/:tenantId/tickets/:id` con detalle, estado, botón "Tomar ticket" (asigna `handoff_queue.assigned_to` al administrador autenticado de Fase 13, notifica al cliente por WhatsApp con el nombre real de quien atiende) y "Cerrar ticket".
- Vista de Conversaciones (`/admin/:tenantId/conversaciones/:id`) reemplaza cualquier representación cruda de `messages.tool_calls`/`conversations.state` por una interfaz legible (ej. tarjetas de "tool ejecutada" con nombre/parámetros formateados, no el JSON tal cual).
- Acción "pausar bot para esta conversación" — extiende el kill-switch de `tenants.bot_paused` (Fase 11.4, ya implementado) a nivel de `conversations` individual (columna nueva `conversations.bot_paused`, chequeada en el mismo punto de `src/orchestrator/consumer.ts` que ya chequea el flag de tenant).
- Enlace directo desde un ticket a la conversación de origen.
- ADR-028: decide y documenta si el flujo `/asesor/:token` de Fase 7 se retira o convive con la acción desde el panel.

**Dependencias:** Fase 13 (la atribución "tomado por [nombre]" y el permiso `recibe_tickets` requieren el sistema de administradores).

**Riesgos:** Si ADR-028 decide retirar el flujo de token, hay que migrar cualquier enlace de token ya enviado y pendiente en producción (`handoff_tokens`, `migrations/0015`) antes de desactivarlo — no se puede apagar en caliente sin dejar asesores con un enlace roto a mitad de un caso activo; si decide que convivan, hay que resolver qué pasa si dos canales (token y panel) intentan tomar el mismo ticket a la vez (condición de carrera sobre `handoff_queue.assigned_to`, resolver con el mismo patrón de `UNIQUE`/`ON CONFLICT` ya usado en `orders.idempotency_key`).

**Estimación:** 3 semanas.

**Definición de terminado:**
- [ ] Un administrador puede tomar y cerrar un ticket completo desde el panel, sin usar el enlace de token, con el cliente recibiendo la notificación de "te atiende [nombre]".
- [ ] La vista de detalle de conversación no muestra JSON crudo en ningún punto — todo tool call se lee como texto formateado.
- [ ] Pausar el bot para una conversación puntual detiene las respuestas automáticas solo de esa conversación, verificado contra una segunda conversación del mismo tenant que sigue respondiendo normalmente.
- [ ] ADR-028 aceptada, con la decisión de convivencia/reemplazo del flujo de Fase 7 ejecutada (no solo documentada).

---

## Fase 19 — Integración Multicanal (Instagram, Facebook/Meta)

**Objetivo:** Extender el gateway de mensajería (hoy exclusivamente WhatsApp/Twilio, Fase 3) con un contrato de canal genérico que permita operar también sobre Instagram Direct y Facebook Messenger vía la API de Meta, exponiendo el canal de origen a conversaciones/tickets (Fases 18).

**Entregables:**
- Contrato de gateway genérico (`InboundChannelAdapter`/`OutboundChannelAdapter` o equivalente) que abstrae lo que hoy es Twilio-específico en `src/gateway/` — WhatsApp pasa a ser una implementación de ese contrato, no el único código posible.
- `conversations.channel` (`whatsapp` | `instagram` | `messenger`), poblada desde el adapter que recibió el mensaje; default `whatsapp` para no requerir backfill de conversaciones históricas.
- Adapter de Meta Messenger/Instagram: verificación de firma de webhook (mismo principio que `X-Hub-Signature-256` de Twilio, Fase 3), manejo de su propio equivalente a la ventana de 24h de WhatsApp (Meta tiene una política similar para Messenger).
- Envío saliente (`sendMessage.ts` generalizado) resuelve el canal correcto por conversación, no asume WhatsApp.

**Dependencias:** Ninguna estructural sobre 13-18 — puede ejecutarse en paralelo. La columna `conversations.channel` puede introducirse ya en la Fase 18 (con valor único `whatsapp`) para que esta fase solo tenga que poblarla, no crearla.

**Riesgos:** Es, tal como ya señala `PROPUESTA_V2.md`, la pieza de mayor esfuerzo estructural — subestimarla arrastraría la fecha de todo lo demás si se le asignan las mismas 2-4 semanas típicas de otras fases; verificación de negocio de Meta para permisos de Messenger/Instagram puede tardar semanas, mismo riesgo no controlable que ya vivió la Fase 3 con WhatsApp Business y la Fase 9 con el BSP real; el motor de escalamiento (Fase 7) y el motor de promociones (Fase 17) no deben asumir WhatsApp en ningún punto nuevo que se toque aquí (revisar contra el principio de `docs/plan-escalado-multi-cliente.md`: "¿esto asume algo específico o es genérico?").

**Estimación:** 5-6 semanas (incluye tiempo de espera de verificación de negocio de Meta, no controlable).

**Definición de terminado:**
- [ ] Un mensaje entrante por Instagram Direct genera una conversación con `channel = 'instagram'`, visible en el panel (Fase 18) con el mismo tratamiento que una de WhatsApp.
- [ ] El agente responde correctamente por el mismo canal que recibió el mensaje (una conversación de Messenger no genera una respuesta de WhatsApp).
- [ ] Verificación de firma de webhook implementada y probada para el adapter de Meta, mismo nivel de rigor que Twilio.

---

## Fase 20 — Personalización del Asistente: Voz de Marca, RAG Institucional y Diagnóstico de Configuración

**Objetivo:** Extender el mecanismo de cache jerárquico ya implementado en ADR-021 con un tercer bloque de `system prompt` (voz de marca + RAG institucional), investigar exhaustivamente qué más es razonable hacer configurable en un asistente de ventas con IA, y **reproducir primero, no asumir**, el bug reportado de configuraciones que no surten efecto en producción.

**Entregables:**
- **Diagnóstico primero (bloqueante para el resto de la fase):** reproducir el reporte de "cambios de configuración que no surten efecto" con logs reales de producción/staging. La revisión estática de `resolveBehaviorConfig` (`src/orchestrator/behaviorConfig.ts`) y `tenantsDirectory.ts` durante el diseño de este plan no encontró cacheo evidente — el diagnóstico debe confirmar si es un bug puntual (ej. un campo de la UI que no persiste, un formulario que no invalida algo), una confusión de UX (el operador no ve confirmación de guardado), o efectivamente una brecha entre ADR-021 y el código desplegado. Documentar el hallazgo real antes de tocar el diseño de tono existente.
- Sección "Registro de Voz de Marca": identificadores, iconografía, nomenclatura — almacenada en `tenants.behavior_config` o una tabla nueva (a decidir en ADR-030 según cuánto texto implique).
- Tercer bloque de `system prompt` (RAG institucional: misión/visión/valores) con su propio breakpoint de `cache_control`, siguiendo exactamente el patrón que ADR-021 ya validó en producción (2 bloques hoy, hasta 4 disponibles en la API de Anthropic) — quedarían 1 de los 4 libre tras esta fase.
- Investigación documentada (no implementación comprometida de todo lo que salga) de variables configurables adicionales de un asistente de ventas con IA (tiempos de respuesta ya existen vía ADR-022, mensajes predeterminados, calidez ya existe vía tono) — entregable es el documento de investigación + priorización, no una lista abierta de features nuevas sin evaluar.
- ADR-030: RAG institucional con cache jerárquico de 3 bloques, y el resultado del diagnóstico del bug de configuración.

**Dependencias:** Ninguna estructural de v2. De v1: extiende ADR-021 (implementada, ver hallazgo al inicio de este documento).

**Riesgos:** Un bloque de RAG institucional (misión/visión/valores) es más largo que el bloque de tono actual — riesgo ya documentado en ADR-021 de quedar por debajo del mínimo cacheable en algunos modelos, mitigado igual que ahí (si no cachea, no rompe, solo no ahorra costo); el mecanismo de cache jerárquico solo se beneficia completo con Anthropic como proveedor activo (ADR-021, consecuencias) — mientras el proyecto opere sobre DeepSeek (ver pendiente #4 de la sección de pendientes), esta fase funciona pero sin el ahorro de cache, debe quedar explícito en la comunicación a negocio.

**Estimación:** 3 semanas (1 semana de diagnóstico + 2 de implementación), sin contar el tiempo de investigación documental que puede correr en paralelo.

**Definición de terminado:**
- [ ] Causa raíz del bug de configuración identificada y corregida (o descartada como no reproducible, con evidencia), documentada en ADR-030 antes de dar la fase por cerrada.
- [ ] Un tenant con RAG institucional configurado responde de forma consistente con su misión/valores en un escenario de prueba, verificado con cache-read en la segunda llamada del turno (mismo criterio de verificación que ya usó ADR-021).
- [ ] Documento de investigación de variables configurables entregado con recomendación priorizada (no implementación total comprometida).

---

## Fase 21 — Enlaces Amigables y Templates Interactivos de WhatsApp

**Objetivo:** Que ningún enlace enviado por el asistente (pago, reseñas) se muestre como URL cruda, y que el cierre de pedido se ofrezca como opciones seleccionables (template de WhatsApp) en vez de texto libre.

**Entregables:**
- `messageSplitter.ts` o el punto donde se arma el mensaje final (`extractPaymentLinkUrl`, ADR-024) formatea todo enlace saliente como hipervínculo con texto descriptivo (ej. "Paga aquí" en vez de la URL completa) — sujeto a que el formato de mensajes de WhatsApp lo soporte (verificar límites reales de la API de Meta/Twilio antes de comprometer el diseño final).
- Template de WhatsApp (mensaje interactivo de botones, sujeto al mismo mecanismo de aprobación de plantillas de Meta que ya usa ADR-019) para el cierre de pedido: "Quiero hacer mi pedido" / "Agregar más productos" / "Cancelar mi pedido".
- Extensión del mismo mecanismo a la confirmación binaria de datos de cliente de la Fase 15 (selección "Sí, siguen igual" / "Quiero cambiarlos").

**Dependencias:** Fase 16 (los botones de cierre de pedido necesitan los estados de pedido ya definidos ahí). De v1: extiende `messageSplitter.ts` y las plantillas de **ADR-019**.

**Riesgos:** Toda plantilla nueva de WhatsApp requiere aprobación de Meta — mismo bloqueo no controlable que ya vive la Fase 12.3 (`PROPUESTA_V2.md` §4 exige explícitamente no reabrir esa decisión ni saltarse el mecanismo de aprobación); si Meta rechaza o tarda en aprobar el template de botones, el flujo debe degradar a texto libre (comportamiento actual) sin bloquear el cierre de pedido — no se debe lanzar una dependencia dura a una plantilla no aprobada.

**Estimación:** 2 semanas de implementación + tiempo no controlable de aprobación de Meta para las plantillas nuevas.

**Definición de terminado:**
- [ ] Un pago de Wompi y un enlace de reseña llegan al cliente como hipervínculo con texto descriptivo, nunca como URL cruda, verificado en WhatsApp real.
- [ ] Al menos una plantilla de botones de cierre de pedido aprobada por Meta y operando; si no se logra la aprobación antes del cierre de la fase, el fallback a texto libre queda documentado y funcionando (no bloquea el cierre de la fase, mismo criterio que Fase 3 con la aprobación de cuenta BSP).

---

## Fase 22 — Reseñas, Redes Sociales y Cierre Responsive Transversal

**Objetivo:** Unificar visualmente `src/reviews/reviewView.ts` con el resto del panel, evaluar (sin comprometer implementación) integración con Google My Business, y cerrar definitivamente el rediseño responsive de contenido que quedó pendiente desde el cierre de la Fase 11 — ahora extendido a todas las pantallas nuevas de v2 (13-21).

**Entregables:**
- `reviewView.ts` reestilizado con los mismos componentes (`STYLE_BLOCK`/`CLIENT_SCRIPT` de `src/admin/adminPanel.ts`) que ya usa el resto del panel.
- Documento de evaluación (no implementación comprometida) de integración con Google My Business u otras redes de reseñas.
- Patrón "tabla → cards" para pantallas angostas, diseñado una sola vez sobre el inventario completo de tipos de contenido (tablas, inbox de dos paneles, tarjetas KPI, formularios de configuración) — el mismo enfoque que ya anotó `docs/fase-11-panel-admin-dashboard/README.md#pendiente-rediseño-responsive-del-contenido`, aplicado ahora también a Tickets (18), Conversaciones (18), Colaboradores (13) y Categorías/Aliados (14).
- Dashboard de resumen (Fase 11.1) revisado para incorporar los KPIs nuevos que v2 introduce (pedidos abiertos, promociones aplicadas por campaña, tickets tomados desde el panel) sin duplicar el trabajo ya hecho en `overview-kpis.md`.

**Dependencias:** Todas las fases de panel de v2 (13, 14, 17, 18) deben existir para que el rediseño responsive cubra el inventario completo de pantallas nuevas, no solo las de v1.

**Riesgos:** Diseñar el patrón responsive antes de que existan todas las pantallas de v2 obligaría a rehacerlo — por eso va al final; si el negocio necesita el panel usable en celular antes de que 13-21 terminen, debe subir de prioridad igual que ya advirtió el README de Fase 11 para el piloto original.

**Estimación:** 2-3 semanas.

**Definición de terminado:**
- [ ] `reviewView.ts` visualmente consistente con el panel admin, verificado en una revisión visual directa.
- [ ] Todas las tablas/inbox/formularios nuevos de v2 (13-21) se ven correctamente en una pantalla de celular real, sin scroll horizontal no intencional.
- [ ] Documento de evaluación de Google My Business entregado, sin compromiso de implementación.

---

## Pendientes de v1 (`PROPUESTA_V2.md` §4) — qué pasa con cada uno en v2

| Pendiente | Qué pasa en v2 |
|---|---|
| Cuenta BSP real de WhatsApp | En paralelo a v2, no bloquea el diseño. Si v2 (Fase 19) agrega Instagram/Messenger antes de resolver esto, ambos canales dependerían de verificaciones de negocio pendientes — coordinar con el dueño de ForMotos antes de comprometer fecha de Fase 19. |
| Hosting real (Fly.io) | En paralelo, sin relación técnica con ninguna fase de v2. |
| Postgres gestionado real (Supabase) | En paralelo. Relevante para la Fase 14: si el catálogo real ya se migró a Supabase con el esquema viejo antes de ejecutar Fase 14, el backfill de `product_variants` debe correr contra la base de producción real, no solo contra staging. |
| Proveedor de LLM de producción (Claude vs. DeepSeek) | En paralelo, decisión de negocio ya identificada como pendiente. **Relevante para Fase 20**: el ahorro de cache jerárquico de 3 bloques solo aplica completo con Anthropic — mientras se opere sobre DeepSeek, la Fase 20 debe documentarse como "funcional pero sin el ahorro de costo pleno", no presentarse como si el problema de costo estuviera resuelto. |
| Catálogo real de ForMotos | **Debe secuenciarse con la Fase 14**: cargar el catálogo real (~300+ productos) bajo el esquema viejo y migrarlo después duplica trabajo. Recomendación: si el catálogo real aún no se cargó, cargarlo directamente bajo el esquema nuevo de Fase 14; si ya se cargó, la Fase 14 asume ese backfill como parte de su propio entregable, no como trabajo aparte. |
| Umbral de escalamiento por monto (Fase 7) | Sin relación directa con v2, sigue validándose con datos reales del piloto en curso, como ya estaba previsto. La Fase 17 (clasificación de cliente) introduce un umbral nuevo y análogo ("fiel" a partir de N pedidos) — debe seguir el mismo criterio de "validar con datos reales, no de diseño", no fijarse arbitrariamente. |
| Fase 11.4 y 11.5 | **Corrección de estado, ver "Estado real verificado" al inicio de este documento**: ya están implementadas y mergeadas, no pendientes. No requieren ninguna fase de v2 para completarse. |
| Fase 12.3 (reactivación de leads fríos, bloqueada por Meta) | No se reabre la decisión. La Fase 21 (templates interactivos) debe pasar por el mismo mecanismo de aprobación de plantillas de Meta que ya bloquea a 12.3 — mismo tipo de bloqueo, riesgo ya conocido, no un problema nuevo. |
| Rediseño responsive del contenido | Absorbido explícitamente por la **Fase 22**, ahora con alcance ampliado a todas las pantallas nuevas de v2. |
| Multimodalidad (voz/imágenes) | Sigue fuera de v2, exactamente como indicó `PROPUESTA_V2.md` §4. Ninguna fase de 13 a 22 la incluye. Candidata a fase propia futura si el negocio la prioriza. |

---

## Resumen de duración estimada

Fases 13 a 17 en secuencia estricta (dependencia técnica real): **15-17 semanas**. Fases 18, 19 y 20 pueden ejecutarse en paralelo entre sí y en paralelo con 14-17 (sin dependencia de esquema compartido): la más larga de las tres (Fase 19, multicanal) marca el ritmo con **5-6 semanas**, más el tiempo no controlable de verificación de negocio de Meta. Fase 21 depende de 16 y agrega **2 semanas** de implementación (más tiempo no controlable de aprobación de plantillas). Fase 22 va al final y depende de que 13/14/17/18 ya existan, agregando **2-3 semanas** de cierre.

Si se paraleliza según lo indicado, el calendario real de v2 queda dominado por la cadena 13→14→15→16→17→21→22 (~24-27 semanas) más el tiempo no controlable de aprobación de Meta (Fases 19 y 21), de forma análoga a como Fase 3 y Fase 9 ya identificaron ese mismo tipo de riesgo en v1.

Este documento cubre únicamente la planificación por fases de v2. No incluye código ni pasos de implementación técnica detallados — esos se definirán al iniciar cada fase, siguiendo el mismo criterio que `MASTER_PLAN.md` usó para v1.
