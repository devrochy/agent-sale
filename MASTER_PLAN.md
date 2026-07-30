# Plan Maestro — Plataforma de Ventas Asistida por IA (WhatsApp + Claude)

## Contexto

El objetivo es construir una plataforma que atienda clientes de PyMEs por WhatsApp (API oficial de Meta), usando Claude como agente principal con Tool Calling para consultar inventario en tiempo real, responder preguntas de producto, generar cotizaciones, crear pedidos, recomendar productos, aplicar promociones, recordar el contexto conversacional y escalar a un asesor humano cuando la conversación lo requiera. Debe soportar miles de conversaciones simultáneas, ser modular, de bajo costo, usar PostgreSQL, GitHub y CI/CD.

Este plan es el resultado de la discusión previa sobre riesgos, cambios de arquitectura, qué quitar/agregar y errores comunes del sector. Las decisiones clave ya tomadas y que este plan asume:

- **No construir el gateway de WhatsApp desde cero** — integrar un BSP existente (Gupshup, 360dialog, Twilio) sobre la API oficial de Meta.
- **Monolito modular** al inicio (no microservicios/Kubernetes desde el día 1).
- **Multi-tenancy con Row Level Security en Postgres desde la primera tabla**, no como añadido posterior.
- **Tool calling con validación estricta**: el LLM propone, las tools deciden contra datos reales (sin alucinaciones de precio/stock).
- **pgvector dentro de Postgres** para recomendaciones, en vez de una vector DB separada.
- **Cola simple** (Redis Streams/SQS) en vez de Kafka, hasta que el volumen lo justifique.
- **Escalamiento a humano por máquina de estados con reglas explícitas**, no delegado al criterio libre del LLM.
- **Idempotencia, auditoría de decisiones del agente, observabilidad y guardrails** como requisitos desde el diseño, no como mejoras posteriores.

Este documento **no incluye código ni pasos de implementación** — es la planificación de fases para llevar el proyecto desde la validación de negocio hasta un piloto operando a escala.

---

## Fase 0 — Descubrimiento y Validación de Negocio

**Objetivo:** Confirmar el problema, el perfil de PyME objetivo y los flujos de venta concretos que el agente debe cubrir, antes de diseñar nada técnico.

**Entregables:**
- Documento de casos de uso priorizados (3-5 flujos de venta reales, ej. "cliente pregunta por producto → cotiza → pide descuento → confirma pedido").
- Perfil de PyME piloto identificado y comprometida a probar el sistema.
- Catálogo de ejemplo (productos, precios, promociones típicas) recopilado de al menos un negocio real.
- Criterios de éxito del MVP (métricas de negocio: tasa de conversión, tiempo de respuesta, % de escalamiento aceptable).

**Dependencias:** Ninguna (fase inicial).

**Riesgos:** Diseñar para un caso de uso genérico que no encaje con ningún negocio real; falta de acceso a un negocio piloto retrasa la validación.

**Estimación:** 1-2 semanas.

**Definición de terminado:** Documento de casos de uso aprobado, con al menos un negocio piloto comprometido y catálogo de ejemplo recopilado.

---

## Fase 1 — Arquitectura Técnica y Diseño de Datos

**Objetivo:** Formalizar el documento de arquitectura (diagramas, decisiones, modelo de datos) sobre las decisiones ya tomadas: monolito modular, Postgres multi-tenant con RLS, BSP para WhatsApp, Claude + tool calling, pgvector, colas simples.

**Entregables:**
- Documento de arquitectura con diagramas (vista de contenedores/componentes).
- Modelo entidad-relación de Postgres: tenants, conversaciones, mensajes, productos, inventario, cotizaciones, pedidos, promociones, handoff_queue, audit_log.
- Contratos de las tools (schemas de entrada/salida) que usará Claude.
- ADRs (Architecture Decision Records) para decisiones clave: BSP elegido, broker de colas, estrategia de caché.

**Dependencias:** Fase 0 (casos de uso definidos).

**Riesgos:** Sobre-diseñar antes de validar con datos reales; elegir BSP sin comparar costos reales entre proveedores.

**Estimación:** 2 semanas.

**Definición de terminado:** Documento de arquitectura revisado y aprobado; modelo de datos validado contra los casos de uso de la Fase 0.

---

## Fase 2 — Fundaciones de Plataforma (Infra base, CI/CD, Multi-tenant)

**Objetivo:** Levantar el esqueleto operativo: repositorio, pipeline CI/CD, entornos, Postgres con RLS multi-tenant, gestión de secretos.

**Entregables:**
- Repositorio en GitHub con estructura modular por dominio.
- Pipeline CI/CD (lint, test, build, deploy a staging automático).
- Postgres provisionado con políticas RLS por tenant.
- Gestión de secretos (vault/secret manager del proveedor de nube).
- Entorno de staging funcional, separado de producción.

**Dependencias:** Fase 1 (modelo de datos y decisiones de infra).

**Riesgos:** RLS mal configurado deja fugas de datos entre tenants; pipeline CI/CD mal diseñado ralentiza la iteración futura.

**Estimación:** 2 semanas.

**Definición de terminado:** Un tenant de prueba no puede ver datos de otro tenant (verificado con test de aislamiento); el pipeline despliega a staging automáticamente en cada merge a main.

---

## Fase 3 — Integración con WhatsApp (BSP) y Gateway de Mensajería

**Objetivo:** Conectar la plataforma a WhatsApp Business API a través de un BSP, con verificación de firma de webhooks y manejo de la ventana de 24h.

**Entregables:**
- Cuenta de BSP configurada y verificada ante Meta.
- Webhook receptor con verificación de firma (`X-Hub-Signature-256`).
- Cola de mensajes entrantes/salientes (Redis Streams o SQS).
- Plantillas de mensajes pre-aprobadas para comunicación fuera de la ventana de 24h.
- Manejo de idempotencia de eventos de webhook.

**Dependencias:** Fase 2 (infra base y colas).

**Riesgos:** El proceso de verificación de negocio de Meta puede tardar semanas (no controlable); mal manejo de idempotencia duplica mensajes o pedidos.

**Estimación:** 2-3 semanas (incluye tiempo de espera de aprobación de Meta).

**Definición de terminado:** Mensaje de prueba enviado y recibido end-to-end (WhatsApp real → cola → confirmación); reenvíos duplicados del webhook no generan efectos duplicados.

---

## Fase 4 — Motor del Agente: Claude + Tool Calling + Memoria de Conversación

**Objetivo:** Construir el orquestador conversacional: integración con Claude, tools con validación estricta, y memoria/estado de conversación persistido en Postgres.

**Entregables:**
- Orquestador (mensaje → contexto → Claude → ejecución de tools → respuesta).
- Tools iniciales: `consultar_inventario`, `responder_pregunta_producto`.
- Esquema de memoria conversacional estructurada en Postgres (estado, no solo texto crudo).
- Estrategia de prompt caching para reducir costo por conversación.
- Log de auditoría de cada decisión/tool call del agente.

**Dependencias:** Fase 3 (mensajes fluyendo), Fase 2 (Postgres disponible).

**Riesgos:** Alucinaciones si las tools no validan contra datos reales; costo de tokens descontrolado sin caching; memoria mal diseñada pierde contexto entre turnos.

**Estimación:** 3 semanas.

**Definición de terminado:** El agente sostiene una conversación de prueba de al menos 10 turnos manteniendo contexto correcto; toda respuesta sobre producto/inventario queda respaldada por una tool call verificable en el log de auditoría.

---

## Fase 5 — Dominio de Catálogo e Inventario en Tiempo Real

**Objetivo:** Modelar y exponer el catálogo/inventario como fuente de verdad consultable en tiempo real.

**Entregables:**
- Modelo de datos de productos/inventario en Postgres.
- Mecanismo de sincronización con la fuente real de inventario (API del cliente, carga CSV, o integración con ERP del piloto).
- Capa de caché (Redis) con invalidación por evento.
- Tool `consultar_inventario` conectada a esta capa.

**Dependencias:** Fase 4 (motor del agente listo para usar tools).

**Riesgos:** Inventario desactualizado si la sincronización falla silenciosamente; integración con el ERP real varía por cliente y puede no estar definida aún.

**Estimación:** 2 semanas.

**Definición de terminado:** Una consulta de stock del agente refleja el inventario real con un desfase máximo documentado y aceptado (ej. 5 minutos).

---

## Fase 6 — Dominio Comercial: Cotizaciones, Pedidos, Promociones, Recomendaciones

**Objetivo:** Construir las tools de negocio que generan valor de venta.

**Entregables:**
- Tool `generar_cotizacion`.
- Tool `crear_pedido` (con idempotency key).
- Tool `aplicar_promocion` (motor de reglas explícito).
- Tool `recomendar_producto` (pgvector + reglas simples, sin ML propio al inicio).
- Tablas de cotizaciones/pedidos/promociones en Postgres con RLS.

**Dependencias:** Fase 5 (catálogo/inventario disponible), Fase 4 (orquestador y memoria).

**Riesgos:** Doble creación de pedidos por falta de idempotencia; promociones mal aplicadas sin motor de reglas claro; recomendaciones irrelevantes si el embedding no está bien curado.

**Estimación:** 3 semanas.

**Definición de terminado:** Flujo completo (preguntar → cotizar → aplicar promoción → confirmar pedido) ejecutado sin duplicados ni datos inconsistentes; reenvío del mismo mensaje no duplica el pedido.

---

## Fase 7 — Escalamiento a Humano (Handoff)

**Objetivo:** Implementar la máquina de estados de escalamiento y la bandeja donde un asesor humano recibe la conversación.

**Entregables:**
- Reglas explícitas de escalamiento (intentos fallidos, palabras clave, monto alto, solicitud explícita del cliente).
- Tabla `handoff_queue`.
- Notificación al asesor (email/webhook/canal simple).
- Vista mínima para que el asesor vea el historial completo y tome la conversación.

**Dependencias:** Fase 4 (memoria conversacional), Fase 6 (contexto comercial disponible).

**Riesgos:** Reglas de escalamiento mal calibradas (escalan de más o de menos); falta de interfaz usable para el asesor.

**Estimación:** 2 semanas.

**Definición de terminado:** Una conversación de prueba dispara escalamiento correctamente según cada regla definida, y aparece en la bandeja del asesor con el contexto completo.

---

## Fase 8 — Observabilidad, Seguridad y Guardrails

**Objetivo:** Instrumentar la plataforma para operar con confianza a escala.

**Entregables:**
- Dashboard de métricas (latencia, tasa de escalamiento, tokens/costo por tenant).
- Tracing end-to-end de la conversación.
- Guardrails de contenido (evitar precios inventados, temas fuera de alcance).
- Alertas de costo por tenant.
- Revisión de seguridad formal (RLS, secretos, firma de webhooks).

**Dependencias:** Fases 3-7 (debe existir flujo real que observar).

**Riesgos:** Instrumentar tarde impide diagnosticar incidentes durante el piloto; guardrails insuficientes permiten respuestas fuera de política.

**Estimación:** 2 semanas.

**Definición de terminado:** Dashboard operativo con datos reales de al menos una semana de tráfico de prueba; auditoría de seguridad sin hallazgos críticos abiertos.

---

## Fase 9 — Piloto Controlado (Beta con 1-2 PyMEs)

**Objetivo:** Validar la plataforma completa con tráfico real de uno o dos negocios piloto, en ambiente controlado.

**Entregables:**
- Al menos una PyME operando en producción con tráfico real limitado.
- Eval suite (golden set de conversaciones) corriendo en CI/CD antes de cada deploy.
- Reporte de resultados del piloto vs. criterios de éxito definidos en la Fase 0.

**Dependencias:** Fases 0-8 completas.

**Riesgos:** Comportamiento inesperado del agente con clientes reales (ambigüedad, groserías, intentos de manipulación/prompt injection); fricción de adopción del negocio piloto.

**Estimación:** 3-4 semanas (incluye período de observación).

**Definición de terminado:** Métricas de éxito de la Fase 0 alcanzadas (o gap documentado), sin incidentes críticos de seguridad o de negocio (pedidos duplicados, fuga de datos entre tenants, precios erróneos) durante el piloto.

---

## Fase 10 — Preparación para Escala y Lanzamiento Multi-tenant

**Objetivo:** Confirmar que la plataforma soporta miles de conversaciones simultáneas y habilitar la incorporación repetible de nuevos tenants.

**Entregables:**
- Prueba de carga simulando miles de conversaciones simultáneas.
- Runbook de onboarding de nuevo tenant — el complemento funcional (qué debe ser configuración de datos, no código) ya está mapeado en `docs/plan-escalado-multi-cliente.md`, escrito durante el diseño de las Fases 11-12.
- Plan de escalado de infraestructura (criterios para pasar de monolito modular a servicios separados).
- Documentación operativa completa.

**Dependencias:** Fase 9 (piloto validado).

**Riesgos:** Cuellos de botella no identificados hasta la prueba de carga real; costo por conversación no sostenible a escala sin optimización adicional.

**Estimación:** 2-3 semanas.

**Definición de terminado:** La prueba de carga sostiene el volumen objetivo con latencia y tasa de error dentro de umbrales aceptables; un segundo tenant piloto se incorpora usando el runbook sin intervención manual fuera de lo documentado.

---

## Fase 11 — Panel de Administración y Analítica

**Objetivo:** Evolucionar el panel admin actual (solo tenants/catálogo/pedidos, de solo lectura) a una herramienta operativa real para gestionar el asistente de ventas — inbox de conversaciones, leads, tickets de escalamiento, flujo del agente, conexiones de canal, kill-switch y analítica de costos — con la marca del panel parametrizada por tenant para poder escalarlo a distintos clientes (ver `docs/fase-11-panel-admin-dashboard/README.md`).

**Entregables:**
- Nuevo home por tenant con KPI cards, actividad reciente y marca configurable (`tenants.display_name`).
- Inbox de conversaciones, tabla de leads y listado agregado de tickets de escalamiento.
- Vista de flujo del agente con contadores reales por tool, y tarjeta de conexión del canal WhatsApp/Twilio.
- Kill-switch de pausa del bot por tenant (`tenants.bot_paused`).
- Tabla `llm_usage` en Postgres con costo/tokens/latencia por llamada al LLM, y panel de Costos/Estadísticas nativo.
- 4 ADRs nuevas (ADR-014 a ADR-017): arquitectura frontend del panel, alcance de autenticación, parametrización de marca, persistencia de uso de LLM.

**Dependencias:** Fase 9 (necesita conversaciones/pedidos reales de un piloto para que el panel tenga datos que mostrar). **Sin dependencia de la Fase 10** — son preocupaciones distintas (herramienta operativa vs. infraestructura de escala) y pueden ejecutarse en paralelo, o esta fase incluso antes.

**Riesgos:** Expectativa del usuario/negocio por encima del alcance real entregado (el panel de referencia usado como inspiración de UX sugiere más de lo que esta fase construye — Conocimiento/RAG, tono editable en vivo e Insights por IA quedan explícitamente fuera, ver `mapeo-funcionalidades.md`); costo recurrente de escritura por llamada al LLM si el volumen de conversaciones crece antes de la Fase 10; divergencia entre `llm_usage` (Postgres) y los logs de Loki si el insert best-effort falla silenciosamente.

**Estimación:** 4-5 semanas (5 sub-fases secuenciales, 11.1 a 11.5, detalladas en `docs/fase-11-panel-admin-dashboard/`).

**Definición de terminado:** Las 5 sub-fases completas con datos reales de ForMotos (ver checklist detallado en `docs/fase-11-panel-admin-dashboard/README.md#definición-de-terminado`); en particular, el kill-switch verificado end-to-end y el panel de Costos mostrando al menos una semana de datos reales de `llm_usage`.

---

## Fase 12 — Capacidades Proactivas del Agente

**Objetivo:** Incorporar comportamiento proactivo del agente más allá de responder mensajes entrantes — seguimiento de ventas frías, reportes automáticos, guardrails más estrictos, encuestas y reseñas — evaluado a partir de un análisis de 12 capacidades candidatas ("superpoderes"), sin adoptar ningún modelo de gating tipo PRO/FREE (ver `docs/fase-12-capacidades-proactivas-agente/README.md`).

**Entregables:**
- Infraestructura de jobs programados en proceso (`node-cron`, ADR-018), sin dependencia externa nueva.
- Guardrail de invención extendido de precio a stock.
- Instrucción de multi-idioma en el system prompt (sin romper prompt caching).
- Reporte diario, seguimiento de cotizaciones frías ("cazador de ventas"), encuestas de satisfacción y solicitud de reseñas — todos operando dentro de la ventana de 24h de mensajería de WhatsApp (ADR-019).
- Reactivación de leads fríos (fuera de la ventana de 24h) documentada como bloqueada hasta obtener aprobación de plantillas de Meta — no implementada hasta entonces.
- Cobros por WhatsApp con Wompi (12.4): link de pago único (tarjeta/PSE/Nequi/Bancolombia Transfer) con confirmación automática vía webhook — decisión explícita del usuario de priorizarlo dentro de esta fase, ver ADR-024.
- Análisis de factibilidad (sin implementación comprometida) de multimodalidad (voz/imágenes entrantes), marcada como candidata a fase propia futura.

**Dependencias:** Fase 7 (handoff/notificación WhatsApp ya construida, reutilizada aquí), Fase 11 (panel donde se muestran los resultados de varias de estas capacidades). Sin dependencia de la Fase 10.

**Riesgos:** Tiempo de aprobación de plantillas de Meta no controlable (bloquea 12.3, mismo riesgo que ya vivió la Fase 3 con la verificación de cuenta BSP); subestimar el esfuerzo de multimodalidad si se intenta meter en esta fase en vez de tratarla como candidata a fase propia; cuenta comercial de Wompi en producción (12.4) es un prerrequisito de negocio pendiente, no técnico.

**Estimación:** 3-4 semanas para 12.1, 12.2 y 12.4; 12.3 sin estimar hasta iniciar el trámite de plantillas con Meta.

**Definición de terminado:** Ver checklist detallado en `docs/fase-12-capacidades-proactivas-agente/README.md#definición-de-terminado`.

---

## Resumen de duración estimada

Fase 0-10 en secuencia: **~24-28 semanas** (algunas fases pueden solaparse parcialmente, ej. Fase 8 con Fase 6-7, reduciendo el calendario real). Fase 11 agrega **4-5 semanas** adicionales, sin bloquear ni ser bloqueada por la Fase 10 (puede ejecutarse en paralelo). Fase 12 agrega **3-4 semanas** más (12.1-12.2; 12.3 sin estimar por depender de aprobación externa de Meta), tampoco bloqueada por la Fase 10.

Este plan cubre únicamente la planificación por fases solicitada. No incluye código ni pasos de implementación técnica detallados — esos se definirán al iniciar cada fase.
