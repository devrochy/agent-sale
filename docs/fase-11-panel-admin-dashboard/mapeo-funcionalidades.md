# Mapeo de funcionalidades: panel de referencia → agent-sale

Panel de referencia analizado: producto "Forja", marca visible "HorizontesAgentOS" (`https://forja-starter-6a4e50.devrochy.workers.dev/admin/overview`) — un producto externo usado solo como inspiración de UX, no como modelo de negocio a replicar (su capa PRO/FREE de upsell no aplica aquí). Cada fila indica qué tan reutilizable es lo que ya existe en agent-sale hoy, verificado contra el código real (no supuesto), y dónde queda cada funcionalidad.

Esta tabla cubre las secciones del panel visibles en `/admin/overview` y sus sub-páginas. La página `/admin/upgrade` de ese mismo producto (marketing de su capa PRO, "12 superpoderes") se analiza aparte en [Fase 12 — Capacidades Proactivas del Agente](../fase-12-capacidades-proactivas-agente/analisis-superpoderes.md), porque son en su mayoría comportamiento nuevo del agente/orquestador, no vistas nuevas del panel — varias de las filas "excluidas" abajo (Cobros, Reseñas) se retoman ahí con un análisis de factibilidad más detallado, ya sin el filtro de "es esto una pantalla del panel".

| Sección referencia | Reutilizable hoy | Qué falta construir | Valor/Esfuerzo | Dónde |
|---|---|---|---|---|
| KPI cards (mensajes, clientes únicos) | Alto — `messages`, `customers`, `conversations` ya tienen todo | Queries de conteo nuevas | Alto/Bajo | [11.1](./overview-kpis.md) |
| Costo del mes | Ninguno en Postgres hoy | Tabla `llm_usage` + punto de escritura + tabla de precios | Alto/Medio | [11.5](./analitica-costos.md) |
| Actividad 7 días (barras) | Alto — `messages.created_at` | Query `group by` + SVG server-side | Alto/Bajo | [11.1](./overview-kpis.md) |
| Conversaciones recientes | Alto — patrón ya existe en `handoffView.ts` | Vista lista, reusar helpers | Alto/Bajo | [11.1](./overview-kpis.md) |
| % resueltas sin humano | Total — ya es la query de `metricas-cierre-ventas.md` | Nada, solo reusar | Alto/Muy bajo | [11.1](./overview-kpis.md) |
| Mejoras sugeridas (IA sobre huecos de conocimiento) | Ninguno | Requiere el subsistema de Conocimiento (no existe) | Bajo/Alto | **excluido** |
| Bandeja/Conversaciones (inbox) | Alto — `conversations`+`messages`, `tool_calls` ya se guarda | Layout inbox htmx, filtros por tab | Medio/Medio | [11.2](./conversaciones-leads-tickets.md) |
| Bandeja/Leads | Medio — `customers` da fecha/nombre/contacto | "Resumen" y "estado" derivados heurísticamente (no LLM) | Medio/Medio | [11.2](./conversaciones-leads-tickets.md) |
| Bandeja/Cobros | Ninguno — sin pasarela de pagos integrada | Integración de pasarela de pago (ej. Stripe) + webhook de confirmación | Alto/Alto | **fuera de la Fase 11**, analizado en [Fase 12 #12](../fase-12-capacidades-proactivas-agente/analisis-superpoderes.md) — candidato a fase propia |
| Bandeja/Tickets | Total — es `handoff_queue`, ya tiene cola y vista de asesor por token | Vista de listado agregada (hoy solo por token individual) | Alto/Bajo | [11.2](./conversaciones-leads-tickets.md) |
| Reseñas/Campañas/Plantillas | Ninguno para Campañas/Plantillas. Reseñas es parcialmente viable: `sendWhatsAppMessage` ya existe y el envío cabe dentro de la ventana de 24h al cerrar la conversación | Campañas/Plantillas siguen requiriendo WhatsApp Business Templates (Meta), no soportado hoy. Reseñas solo necesita un link configurable por tenant + criterio de "cliente contento" | Campañas/Plantillas: Bajo/Alto. Reseñas: Medio/Bajo | Campañas/Plantillas **excluidas**; Reseñas analizada en [Fase 12 #11](../fase-12-capacidades-proactivas-agente/analisis-superpoderes.md) |
| Mi Agente/Flujo (diagrama) | Medio — `toolExecutor.ts` ya ejecuta y loguea cada tool call, `messages.tool_calls` ya lo persiste | Diagrama estático con nodos reales del proyecto + contadores por tool | Medio/Medio | [11.3](./flujo-conexiones.md) |
| Mi Agente/Conocimiento | Ninguno | Dominio RAG completo nuevo (tabla de documentos, chunking, ingestión, tool de retrieval) | Bajo(ahora)/Alto | **excluido de la Fase 11**, candidato a fase propia futura |
| Mi Agente/Conexiones | Alto — env vars de Twilio ya existen | Tarjeta de estado leyendo `env`; sin canales nuevos reales (Telegram/Meta/ManyChat no implementados) | Medio/Bajo | [11.3](./flujo-conexiones.md) |
| Mi Agente/Configuración (tono/velocidad/estilo/cerebro) | Ninguno — choca con el requisito de prompt byte-idéntico para prompt caching | Requiere rediseñar la estrategia de prompt por tenant (ADR futura) | Bajo/Alto | **reducido**: solo kill-switch en [11.4](./configuracion-comportamiento.md) |
| Análisis/Insights (resumen IA por conversación) | Ninguno | Llamada LLM nueva por conversación cerrada, costo recurrente | Medio/Alto | **stretch goal**, no comprometido — ver [11.5](./analitica-costos.md#insights-por-ia-stretch-goal-no-comprometido) |
| Análisis/Estadísticas | Medio vía datos ya existentes (`messages`, `conversations`) | Agregados nativos en Postgres (no Grafana embebido — ver [ADR-017](./adrs/ADR-017-persistencia-uso-llm-postgres.md)) | Alto/Medio | [11.5](./analitica-costos.md) |
| Análisis/Costos | Ninguno en Postgres hoy | Tabla `llm_usage`, tabla de precios | Alto/Medio | [11.5](./analitica-costos.md) |
| Marca configurable en el header | — | Columna `tenants.display_name` | Alto/Bajo | [11.1](./overview-kpis.md), [ADR-016](./adrs/ADR-016-parametrizacion-marca-tenant.md) |

## Resumen de exclusiones (con razón, no omisión silenciosa)

- **Conocimiento/RAG**: no existe el subsistema base — es un dominio nuevo completo, no una vista sobre datos existentes. El único uso de `embedding`/pgvector en el proyecto es sobre `products`, para la tool `recomendar_producto`, no sobre documentos.
- **Cobros por WhatsApp**: sin pasarela de pagos integrada; los pedidos solo registran el método de pago (`transferencia`/`efectivo_contraentrega`/`tarjeta`), no procesan el cobro. Retomado con más detalle en [Fase 12](../fase-12-capacidades-proactivas-agente/analisis-superpoderes.md) como candidato a fase propia (integración de pasarela real).
- **Campañas/Plantillas**: requieren WhatsApp Business Templates de Meta, fuera de lo que soporta la integración actual vía Twilio. Reseñas, que el panel de referencia agrupaba en la misma sección, **sí** es factible sin plantillas (dentro de la ventana de 24h) — ver [Fase 12 #11](../fase-12-capacidades-proactivas-agente/analisis-superpoderes.md).
- **Tono/personalidad editable en vivo**: rompería el requisito de system prompt byte-idéntico que sostiene el prompt caching (`docs/fase-4-motor-agente/prompt-caching.md`). Multi-idioma, que a primera vista parece el mismo tipo de personalización, **no** tiene este problema por ser una instrucción fija igual para todos los tenants — ver [Fase 12 #8](../fase-12-capacidades-proactivas-agente/analisis-superpoderes.md).
- **Insights por IA**: viable técnicamente, pero con costo recurrente no trivial — se difiere hasta tener datos reales de costo (que esta misma fase habilita medir) para decidir si vale la pena.

Ninguna de estas exclusiones es definitiva — cada una queda documentada con el motivo concreto y, donde aplica, la condición que la reabriría (ver cada sub-fase enlazada, o el análisis ampliado de la [Fase 12](../fase-12-capacidades-proactivas-agente/analisis-superpoderes.md) para las capacidades de comportamiento del agente que van más allá de lo que cabe en un panel).
