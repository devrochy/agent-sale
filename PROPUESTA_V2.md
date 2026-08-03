# Propuesta v2 — Agent Sale

**Documento de solicitud para Claude Code.** Este texto no es código ni un plan cerrado: es el encargo que Rob le hace a Claude Code para que analice el estado actual del proyecto (v1) contra el conjunto de mejoras descritas abajo (v2), y produzca una planificación ordenada — con el mismo nivel de rigor que ya tiene `MASTER_PLAN.md` — antes de tocar una sola línea de código.

---

## 0. Instrucciones de proceso para Claude Code

1. **Leer antes de planificar.** Como mínimo: `MASTER_PLAN.md`, `docs/fase-1-arquitectura/modelo-datos.md`, `docs/fase-1-arquitectura/contratos-tools.md`, el README de cada fase (`docs/fase-*/README.md`), las ADRs aceptadas de las fases 11 y 12, y `docs/fase-9-piloto-controlado/pendientes-pre-piloto.md`. La sección 2 de este documento resume lo más relevante, pero no reemplaza esa lectura.
2. **Analizar antes de proponer.** Para cada mejora del bloque 3, indicar explícitamente:
   - si **extiende** una fase/sub-fase/tool/tabla ya existente (decir cuál, con ruta al archivo),
   - si **choca** con una decisión ya tomada (ADR aceptada) y por tanto esa ADR debe revisarse o reemplazarse — no ignorarse en silencio,
   - si es **completamente nueva** y no tiene equivalente en v1.
3. **Planificar en el mismo formato que `MASTER_PLAN.md`.** Cada fase nueva con Objetivo, Entregables, Dependencias, Riesgos, Estimación y Definición de terminado. Numerar las fases nuevas continuando desde la **Fase 13** (la Fase 12 es la última cerrada en v1). No es obligatorio que cada bloque de la sección 3 sea una fase 1:1 — Claude Code puede agrupar o dividir bloques si la dependencia técnica real lo justifica, siempre que quede explicado por qué.
4. **No perder los pendientes de v1** (sección 4). El plan de v2 debe decir, para cada uno, si se resuelve antes de v2, en paralelo, o se incorpora dentro de alguna fase nueva. Ninguno puede quedar tácitamente descartado.
5. **Estrategia documental en dos etapas — no mezclar todavía:**
   - **Etapa 1 (ahora):** no editar el contenido de las fases 0-12 ya existentes. Toda la planificación de v2 va en documentación **separada y claramente marcada como v2** (por ejemplo `MASTER_PLAN_V2.md` en la raíz, espejo de `MASTER_PLAN.md`, más `docs/fase-13-.../`, `docs/fase-14-.../` etc. siguiendo el mismo patrón de carpetas que ya usan las fases 0-12). El objetivo es que el piloto v1 (ForMotos, en curso) y su documentación validada no se toquen mientras v2 está en diseño.
   - **Etapa 2 (al pasar a producción):** cuando el negocio confirme que v2 está lista para producción, fusionar `MASTER_PLAN.md` + `MASTER_PLAN_V2.md` en un único documento con numeración continua de fases, y unificar las carpetas `docs/fase-N-*` en un solo árbol. En ese punto no debe quedar ninguna mención de "v1" o "v2" en la documentación — un único plan maestro, como si siempre hubiera sido uno solo. Este documento (`PROPUESTA_V2.md`) puede archivarse o borrarse en ese momento; ya habrá cumplido su función.
6. **No implementar código en esta primera pasada** a menos que Rob lo pida explícitamente fase por fase — el entregable esperado de este encargo es la planificación (documentos + ADRs nuevas donde haga falta), igual que en v1 las fases se diseñaron antes de implementarse.

---

## 1. Objetivo general de v2

Desarrollar una segunda versión del plan maestro de Agent Sale que profundice la gestión administrativa (login real, roles, colaboradores), el flujo de pedidos y clientes (direcciones, guía de envío, estados de pago), la gestión de tickets integrada al panel, el motor de promociones (por cliente/producto/campaña), la personalización del asistente (voz de marca, RAG institucional) y la operación multicanal (Instagram, Facebook/Meta) — construyendo sobre lo ya diseñado y, donde exista, implementado en v1, no en paralelo a ello.

---

## 2. Estado de v1 que Claude Code debe tener en cuenta

**Fases 0-9 (diseño):** completas. Fases 10-12 con estado mixto:

- **Fase 10 (Preparación para escala/multi-tenant):** su objetivo explícito incluye la identidad/login por tenant — es el "disparador natural" que **ADR-015** ya señaló para revisar autenticación real. Varias mejoras del bloque 3 (autenticación, roles de colaborador) reabren esta fase directamente.
- **Fase 11 (Panel admin):** 11.1, 11.2 y 11.3 implementadas y mergeadas a `develop` (KPIs, Conversaciones/Leads/Tickets de solo lectura, Flujo/Conexiones). **11.4 y 11.5 siguen en diseño, sin implementar.** El rediseño responsive del contenido de cada sección (tablas, inbox) también quedó pendiente para el cierre de la fase.
- **Fase 12 (Capacidades proactivas):** 12.1, 12.2 y 12.4 (Wompi) completas e implementadas. **12.3 (reactivación de leads fríos) bloqueada** hasta obtener plantillas aprobadas por Meta — no se debe reabrir esa decisión, solo respetarla. Multimodalidad quedó fuera, marcada como candidata a fase propia.

**Decisiones ya tomadas (ADRs) que varias mejoras de v2 tocan directamente y que Claude Code debe revisar, no asumir:**

- **ADR-015** — hoy el panel usa una sola credencial Basic Auth global (`ADMIN_USER`/`ADMIN_PASSWORD`), sin usuarios ni sesiones ni roles. La ADR documenta esto como aceptable *solo* mientras exista un único tenant real y difiere el login verdadero a la Fase 10. El bloque 3.1 de este documento pide exactamente eso.
- **ADR-021** — el tono/estilo del agente (`tenants.behavior_config`) ya se resolvió con un segundo bloque de `system prompt` con `cache_control` propio, específicamente para no romper el prompt caching de Claude. El bloque 3.7 menciona una falla actual donde los cambios de configuración "no surten efecto" — Claude Code debe verificar si es un bug de implementación sobre un diseño ya resuelto, o si hay una brecha real entre el ADR y el código desplegado, antes de proponer nada nuevo ahí.
- **Handoff/tickets (`docs/fase-7-escalamiento-humano/`)** — hoy el flujo de tomar/resolver un ticket ya existe, pero vive en `POST /asesor/:token/tomar|resolver` (acceso por token individual enviado por WhatsApp), **no** en el panel admin. La Fase 11.2 solo agregó un listado de **solo lectura** sobre `handoff_queue` ("Reasignar o resolver tickets desde este listado" quedó explícitamente fuera de esa fase). El bloque 3.3/3.4 pide mover ese flujo de acción al panel — es una extensión real, con una decisión de diseño pendiente: ¿el flujo de token por WhatsApp se reemplaza o convive con la acción desde el panel?
- **Motor de promociones (`docs/fase-6-dominio-comercial/motor-promociones.md`)** — hoy solo evalúa por temporada y por volumen, elige siempre la de mayor beneficio y **no combina promociones**. No hay ningún concepto de promoción por cliente/aliado, por categoría/subcategoría, ni de campañas con restricción de una vez por cliente, ni de estados de cliente (nuevo/recurrente/fiel). El bloque 3.6 es una extensión real del motor y del modelo de datos (`promotions`), no un ajuste menor.
- **Modelo de datos (`docs/fase-1-arquitectura/modelo-datos.md`)** — `products.category` es un campo de texto plano, sin jerarquía ni subcategorías ni referencia a un "aliado". `customers` solo guarda `phone_number`, `name`, `created_at` — no hay dirección, cédula, ni progresividad de datos. No existe ninguna tabla de administradores/colaboradores ni de canal de origen distinto a WhatsApp. El bloque 3.10 (detallado en 3.10.1) requiere rediseñar varias tablas, no solo agregar columnas sueltas.
- **Canal único (Fase 3 — WhatsApp/Twilio)** — no existe ninguna integración con Instagram o Facebook/Meta en el código actual. El bloque 3.10 es, dentro de todo lo pedido, la pieza de mayor esfuerzo estructural (gateway nuevo, no una extensión del existente).

---

## 3. Bloques de mejora propuestos para v2

### 3.1 Autenticación real y gestión de colaboradores
Reemplazar el Basic Auth global (ADR-015) por un sistema de login con usuarios y contraseñas encriptadas, contra una tabla nueva de administradores. Un administrador *master* gestiona una sección de "Colaboradores": activar/desactivar cuentas, y asignar permisos granulares (recibir reportes diarios, recibir tickets, recibir notificaciones de pedidos pagados, etc.). Esto es, en la práctica, reabrir el alcance de autenticación que ADR-015 difirió a la Fase 10 — debe decidirse si se ejecuta como parte de la Fase 10 real o como fase propia de v2.

### 3.2 Flujo de pedidos y datos de cliente
Al confirmar un pedido, verificar si el cliente ya tiene dirección, teléfono, cédula y nombre completo; si no, el asistente los solicita y confirma que sean correctos antes de continuar. Si ya existen, se consultan al final del pedido con opción de confirmar o cambiar (vía template de WhatsApp o mecanismo equivalente de selección binaria) — el cambio puede ser temporal (solo ese envío) o permanente (actualiza el perfil). Un pedido abierto y pendiente de pago debe poder recibir productos adicionales antes de cerrarse, sin crear un pedido nuevo.

### 3.3 Estado, seguimiento y pagos de pedidos
Integrar el estado de Wompi (exitoso/rechazado/pendiente) directamente al estado del pedido en el panel. Cada pedido recibe un número único que el cliente puede usar para consultar su estado. Notificar al administrador cuando un pedido queda aprobado; los pedidos pendientes se cierran automáticamente a los 5 días sin pago. Registrar número de guía y transportadora, y notificar automáticamente al cliente al registrarse la guía.

### 3.4 Notificaciones administrativas y reportes
Alertas por WhatsApp a uno o más administradores configurados ante cambios de estado relevantes (pago exitoso, pedido rechazado, ticket nuevo). Reporte diario de ventas y actividad — construye sobre el job ya existente de la Fase 12.2 (`dailyReport.ts`), extendiéndolo con destinatarios configurables por permiso (ver 3.1).

### 3.5 Tickets integrados al panel (reemplaza el flujo de solo lectura de la Fase 11.2)
Mover la gestión de tickets del flujo actual por token (`/asesor/:token`) a una sección del panel con: detalle y estado del ticket, acción de "tomar ticket" (asigna al administrador, notifica al cliente con el nombre de quien atiende), enlace directo a la conversación de origen una vez tomado, y acción de "cerrar ticket". Acceso rápido desde el ticket al canal de comunicación real (WhatsApp, Instagram o Meta, según 3.10).

### 3.6 Panel de conversaciones mejorado
"Conversaciones recientes" del resumen debe enlazar directo al detalle completo. Mejorar filtros de búsqueda. Reemplazar la visualización cruda de JSON en el detalle de conversación por una interfaz legible. Desde esa misma vista: pausar el bot para esa conversación puntual y continuarla manualmente, y tomar un ticket sin salir de la vista. Mostrar el canal de origen de cada conversación (WhatsApp, Instagram, Meta).

### 3.7 Motor de promociones avanzado y clasificación de clientes
Extender `promotions`/el motor de reglas (`docs/fase-6-dominio-comercial/motor-promociones.md`) para soportar promociones por aliado/cliente estratégico (ej. descuentos exclusivos en productos de un aliado como "Ramos"), por producto o categoría/subcategoría, y por campaña (bienvenida, temporada, blackfriday) con restricción de una aplicación por campaña por cliente. Requiere un estado/clasificación de cliente (nuevo, recurrente, fiel, etc.) para poder evaluar elegibilidad. La promoción debe evaluarse y comunicarse **proactivamente** al inicio de la conversación o al detectar interés en una categoría/producto con descuento — no como pregunta al final, que es el comportamiento actual a corregir.

### 3.8 Configuración del asistente: voz de marca, RAG y parametrización
Sección de "Registro de Voz de Marca" (identificadores, iconografía, nomenclatura, tono) más un RAG con misión/visión/valores de la empresa para alinear el comportamiento del asistente. Esto debe diseñarse en conjunto con **ADR-021** (tono ya resuelto vía bloque de `system prompt` con `cache_control` propio) para no reabrir el problema de prompt caching que esa ADR ya cerró. Ampliar además las variables configurables del asistente (tiempos de respuesta, mensajes predeterminados, calidez, etc.) con una investigación exhaustiva de qué es configurable en un asistente de ventas con IA, y corregir la falla reportada de que ciertos cambios de configuración no surten efecto en producción (ver nota de la sección 2 sobre ADR-021).

### 3.9 Enlaces amigables y templates interactivos de WhatsApp
Todo enlace enviado por el asistente (pago Wompi, reseñas, etc.) se muestra como hipervínculo con texto descriptivo, nunca la URL completa. Implementar templates de WhatsApp para estructurar el cierre de pedido ("Quiero hacer mi pedido" / "Agregar más productos" / "Cancelar mi pedido") como opciones seleccionables, no texto libre.

### 3.10 Esquema de base de datos ampliado

Rediseñar/extender el modelo de datos (`docs/fase-1-arquitectura/modelo-datos.md`) para cubrir, como mínimo: tabla de administradores con roles y permisos (3.1); captura progresiva de datos de cliente (lo que llega de Twilio/WhatsApp al inicio, completado con dirección/documento/municipio/ciudad al cerrar un pedido); y el campo de elegibilidad de producto a promoción que requiere 3.7. El catálogo (productos, categorías, variantes, aliados) es la parte de mayor cambio estructural y se detalla aparte en 3.10.1, porque hoy `products.category` es un solo campo de texto plano y no existe ningún concepto de variante ni de aliado en el modelo de datos actual.

#### 3.10.1 Propuesta de esquema de catálogo (categorías, variantes, aliados)

Esta es una propuesta de punto de partida para que Claude Code la valide/ajuste durante la Fase de diseño correspondiente — no una decisión cerrada.

**Aliados (`allies`)** — tabla nueva: `id`, `tenant_id`, `name`, `contact_info`, `active`, `created_at`. Cada producto pertenece a un aliado (`products.ally_id`, obligatorio o con un aliado "genérico" por defecto para productos propios de ForMotos que no vienen de un tercero — a decidir). Permite listar productos por aliado y es el punto de anclaje para promociones exclusivas de aliado (3.7, ej. "Ramos" con 10% en sus productos).

**Categorías jerárquicas (`product_categories`)** — el caso real que reportaste (`Para motos › Otros para motos › Iluminación › Exploradoras`, 4 niveles) descarta un esquema fijo de 3 columnas (`category`/`subcategory`/`sub_subcategory`): un nicho puede necesitar más niveles que otro, y forzar columnas fijas obliga a dejarlas vacías o a inventar niveles que no aplican. La alternativa es un **árbol auto-referenciado**, con profundidad libre:

```
product_categories
  id            uuid PK
  tenant_id     uuid FK
  parent_id     uuid FK → product_categories.id (null = nivel raíz = "nicho": Motos, Carros, Otros)
  name          text        -- "Lubricantes", "Aceite", "Otros para motos", "Iluminación", "Exploradoras"
  sort_order    int
  active        boolean
```

Un producto se asocia a la categoría **más específica** que le corresponda (`products.category_id` → el nodo hoja, ej. "Exploradoras"); la ruta completa ("Para motos › Otros para motos › Iluminación › Exploradoras") se reconstruye recorriendo `parent_id` hacia arriba, sin necesidad de guardarla duplicada. Esto es lo que permite la parametrización pedida: una sección nueva del panel administra este árbol (crear/editar/reordenar/desactivar nodos en cualquier nivel) sin tocar código, y un nicho con 2 niveles y otro con 5 conviven en el mismo esquema sin cambios.

**Variantes por color, talla, etc. (`product_variants`)** — no todos los productos tienen variantes (un aceite normalmente no; un casco o unos guantes sí, por talla y color), y los que las tienen no siempre usan los mismos atributos. Se propone separar el producto "genérico" (lo que el cliente busca y el asistente recomienda) de sus variantes concretas (lo que realmente tiene un SKU, un precio y un stock):

```
products                         -- el producto tal como lo busca/pregunta el cliente
  id            uuid PK
  tenant_id     uuid FK
  ally_id       uuid FK → allies.id
  category_id   uuid FK → product_categories.id   -- nodo hoja
  name          text
  description   text
  embedding     vector            -- ya existe, para recomendación (Fase 5)
  has_variants  boolean

product_variants                 -- lo que realmente se vende, tiene SKU, precio y stock propios
  id            uuid PK
  product_id    uuid FK → products.id
  sku           text unique
  attributes    jsonb             -- {"talla": "M", "color": "Rojo"} — flexible por tipo de producto
  price         numeric
  active        boolean
```

`attributes` en `jsonb` (mismo patrón ya usado en `promotions.rules`, ver `modelo-datos.md`) porque el conjunto de atributos varía por producto: un casco usa `{talla, color}`, unos guantes `{talla, color}`, un aceite podría no tener variantes en absoluto (un solo `product_variant` "default" sin atributos) o usar `{presentacion: "1 litro"}`. Todo producto tiene al menos una variante — incluso los que hoy se ven como "sin variante" simplemente tienen una única fila en `product_variants` sin atributos, para no bifurcar la lógica de precio/stock entre productos con y sin variantes.

**Impacto en tablas ya existentes** — esto es el cambio real que Claude Code debe dimensionar con cuidado, no un agregado aislado: `inventory.product_id`, `quote_items.product_id` y `order_items.product_id` (Fase 1/5/6) hoy apuntan al producto genérico; con variantes, deberían apuntar a `product_variants.id` (una cotización real dice "casco talla M rojo", no solo "casco"). Es una migración que toca los contratos de las tools `consultar_inventario`, `generar_cotizacion` y `crear_pedido` ya definidos en `docs/fase-1-arquitectura/contratos-tools.md` — deben aceptar/devolver `variant_id`, no solo `product_id`. El asistente, al guiar al cliente (ver 3.7 y el "camino feliz" ya descrito en el punto 6 de la propuesta original), necesita preguntar talla/color cuando el producto elegido tiene más de una variante activa, antes de cotizar.

**Elegibilidad a promoción** — con este esquema, una promoción (3.7) puede referenciar `ally_id`, `category_id` (con o sin las categorías hijas) o `product_id`/`variant_id` puntual, cubriendo los tres niveles que pediste (aliado, categoría/subcategoría, producto puntual) sin campos booleanos sueltos en `products`.

### 3.11 Integración multicanal (Instagram, Facebook/Meta)
Extender el gateway (hoy exclusivamente WhatsApp/Twilio, Fase 3) para operar también sobre Instagram y Facebook/Meta, con el canal de origen visible en conversaciones y tickets (3.6, 3.5). Es la pieza de mayor esfuerzo estructural del conjunto — no una extensión menor del webhook actual, sino un gateway adicional con su propio contrato.

### 3.12 Reseñas y redes sociales
Mejorar la interfaz de reseñas (`src/reviews/reviewView.ts`, ya existente desde la Fase 12.2) para que sea consistente con el estilo del panel admin. Evaluar (opcional, no comprometido) integración con Google My Business u otras redes.

### 3.13 Mejoras visuales y de experiencia transversales
Retoma el ítem ya anotado como pendiente en el cierre de la Fase 11 ("rediseño responsive del contenido") y lo extiende a todo lo nuevo de v2 (tickets, panel de conversaciones, configuración de promociones/categorías). Refinar el dashboard de resumen para que la información sea más clara y accionable.

---

## 4. Pendientes de v1 a no perder de vista

Estos ítems ya estaban documentados como pendientes antes de esta propuesta y **no deben quedar tácitamente absorbidos ni descartados** por el plan de v2:

- **`docs/fase-9-piloto-controlado/pendientes-pre-piloto.md`** — cuenta BSP real de WhatsApp, hosting real en Fly.io, Postgres gestionado real (Supabase), proveedor de LLM de producción (hoy operando sobre DeepSeek por un pago rechazado con Anthropic), catálogo real de ForMotos cargado, y validación del umbral de escalamiento por monto. Ninguno de estos bloquea el *diseño* de v2, pero si v2 va a producción antes de resolverlos, el plan debe decirlo explícitamente.
- **Fase 11.4 y 11.5** — configuración avanzada (más allá del kill-switch ya resuelto) y analítica de costos, diseñadas pero no implementadas.
- **Fase 12.3** — reactivación de leads fríos, bloqueada por aprobación de plantillas de Meta. No se reabre esta decisión; si v2 introduce templates nuevos (3.9), deben respetar el mismo mecanismo de aprobación.
- **Rediseño responsive del contenido** (tablas, inbox) — pendiente desde el cierre de la Fase 11, ahora ampliado por 3.13.
- **Multimodalidad** (voz/imágenes entrantes) — explícitamente fuera de la Fase 12, candidata a fase propia. No forma parte de esta propuesta de v2 tampoco, salvo que Rob decida incluirla.

---

## 5. Criterio de fusión a versión única (al pasar a producción)

Cuando Rob confirme que v2 está lista para producción:

1. Fusionar `MASTER_PLAN.md` y `MASTER_PLAN_V2.md` en un único archivo con numeración continua de fases (sin reiniciar en "Fase 1" ni mantener dos documentos).
2. Unificar las carpetas `docs/fase-N-*` de v1 y v2 en un solo árbol, renumerando si hace falta para que quede una secuencia lógica única.
3. Eliminar cualquier mención de "v1"/"v2"/"segunda versión" del texto de la documentación resultante — debe leerse como si siempre hubiera sido un solo plan.
4. Archivar o borrar este documento (`PROPUESTA_V2.md`) una vez cumplida su función de puente.

---

## 6. Qué se espera de Claude Code en esta primera pasada

Un plan de fases nuevo (Fase 13 en adelante), en el mismo formato que `MASTER_PLAN.md`, con sus README y ADRs correspondientes por sub-fase donde haya una decisión de arquitectura real que registrar — igual que en las fases 0-12. No se espera código todavía. Sí se espera que el plan deje explícito, para cada bloque de la sección 3, su relación con v1 (extiende / choca con ADR / nuevo) y qué pasa con cada pendiente de la sección 4.
