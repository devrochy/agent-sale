# Plan de escalado: de ForMotos a plataforma multi-cliente

Documento de referencia (no ligado a una fase específica, pensado para consultarse al final de la construcción actual, antes de vender/instalar la plataforma para un segundo cliente). Objetivo: que agent-sale pueda operar para **cualquier negocio**, no solo ForMotos/motos, sin tocar código para cada cliente nuevo — el mismo objetivo que persigue Forja con `forjabot install <slug>` (ver [comparativa-arquitectura-forja.md](./comparativa-arquitectura-forja.md)), pero manteniendo la arquitectura ya decidida de monolito multi-tenant compartido (no un despliegue separado por cliente).

## Relación con la Fase 10 del `MASTER_PLAN.md`

La [Fase 10](../MASTER_PLAN.md#fase-10--preparación-para-escala-y-lanzamiento-multi-tenant) ya tiene como entregable un "runbook de onboarding de nuevo tenant" — pero está enfocada en **volumen e infraestructura** (prueba de carga, escalado de servicios). Este documento es el complemento **funcional**: qué necesita volverse configuración de datos (no código) para que ese runbook sea ejecutable en la práctica. Sin resolver lo que aquí se audita, un "onboarding sin intervención manual" (definición de terminado de la Fase 10) no es posible — el onboarding de un cliente nuevo hoy requeriría editar `systemPrompt.ts` y hacer deploy, no solo insertar filas en `tenants`.

## Principio para todo trabajo de aquí en adelante

Antes de dar por cerrada cualquier funcionalidad nueva (Fase 11, Fase 12, o las que sigan), preguntar explícitamente: **¿esto asume ForMotos/motos/español/pesos colombianos, o es genérico y configurable por tenant?** Si asume algo específico, la funcionalidad debe documentar ese acoplamiento explícitamente (como ya hacen [ADR-016](./fase-11-panel-admin-dashboard/adrs/ADR-016-parametrizacion-marca-tenant.md) para la marca y [ADR-019](./fase-12-capacidades-proactivas-agente/adrs/ADR-019-mensajeria-proactiva-ventana-24h.md) para la ventana de WhatsApp), no dejarlo implícito.

## Auditoría: qué ya es parametrizable por tenant hoy vs. qué está acoplado a ForMotos

Verificado contra el código real, no supuesto:

| Dimensión | Estado hoy | Acoplamiento encontrado |
|---|---|---|
| Identidad del tenant | Parametrizable | `tenants.id/name/plan` ya existen desde `migrations/0002_tenants.cjs` |
| Marca visible en el panel | **Diseñado, no implementado** | [ADR-016](./fase-11-panel-admin-dashboard/adrs/ADR-016-parametrizacion-marca-tenant.md) (`display_name`) está "Aceptado" pero no hay migración ni código todavía — es parte de la [Fase 11.1](./fase-11-panel-admin-dashboard/overview-kpis.md) pendiente de implementar |
| Número de WhatsApp — **recepción** | Parametrizable | `tenants.whatsapp_number` (migración `0012`) ya enruta el tenant correcto desde el webhook entrante (`tenantsDirectory.ts`) |
| Número de WhatsApp — **envío** | **No parametrizable** | `src/gateway/sendMessage.ts:29` usa `env.twilioWhatsappNumber`, una sola variable de entorno global — todos los tenants envían desde la misma cuenta/número. `server.ts:47-50` lo admite explícitamente: "mientras el piloto sea de un solo tenant" |
| Reglas de escalamiento (palabras clave, monto alto, intentos fallidos) | Parametrizable | `tenants.escalation_config` jsonb (migración `0014`), con merge sobre defaults (`escalationRules.ts`) — el patrón correcto a replicar para lo demás de esta tabla |
| Catálogo (esquema) | Parametrizable | `products`/`inventory` son genéricos (sku, nombre, precio, categoría libre, stock) — no asumen motos |
| Recomendación de productos complementarios | **No parametrizable** | `recomendarProducto.ts` tiene un mapa fijo `COMPLEMENTARY_CATEGORIES` (casco→[...], llanta→[...]) calibrado para el catálogo de ForMotos, con comentario propio admitiendo que debería ser configurable por tenant |
| Moneda / formato monetario | **No parametrizable** | Hardcodeado a COP (`$` + `toLocaleString("es-CO")`) en `adminPanel.ts:40-41` **y** en el propio texto del `SYSTEM_PROMPT` (`systemPrompt.ts:32`); no existe columna `currency`/`locale` en `tenants` ni `orders` |
| Idioma de respuesta al cliente | Parcial | Ver [Fase 12 #8](./fase-12-capacidades-proactivas-agente/analisis-superpoderes.md) — agregar instrucción de responder en el idioma del cliente es de bajo esfuerzo y no rompe el caching (instrucción fija, no variable por tenant) |
| Idioma de la UI del panel admin | **No parametrizable** | Todo el HTML de `adminPanel.ts`/`handoffView.ts` está en español fijo — aceptable mientras el equipo operador sea hispanohablante; no es lo mismo que el idioma de respuesta al cliente |
| Identidad de marca/rubro dentro del prompt | **El bloqueo central, ver abajo** | `systemPrompt.ts` menciona "ForMotos" y ejemplos de motos directamente en el texto cacheado |

## El bloqueo central: el system prompt mezcla 4 cosas que deberían ser 4 capas distintas

`systemPrompt.ts` hoy es un único string que mezcla, sin separación: (a) instrucciones de comportamiento genéricas (no inventar precios, no salirse de tema — esto sí debería ser igual para todos los clientes), (b) identidad del negocio ("ForMotos", "tienda de accesorios para motocicletas"), (c) formato de moneda (pesos colombianos), y (d) ejemplos de tono con productos específicos del catálogo de motos. Las capas (b)-(d) son exactamente lo que cambia de un cliente a otro; la capa (a) es lo único que debería ser realmente global.

Esto es lo mismo que ya identificó [comparativa-arquitectura-forja.md](./comparativa-arquitectura-forja.md#qué-proponemos-como-mejora-futura-con-esfuerzo-revisado-a-la-baja-frente-a-estimaciones-previas) y lo que dejó pendiente [Fase 11.4](./fase-11-panel-admin-dashboard/configuracion-comportamiento.md) — aquí se posiciona como **el ítem central** del escalado a multi-cliente, no como una mejora cosmética de "tono": sin resolver esto, cada cliente nuevo requiere editar `systemPrompt.ts` a mano y hacer deploy, exactamente lo que un "onboarding sin intervención manual" (Fase 10) busca evitar.

No se decide aquí la solución técnica (esa es la ADR pendiente ya anotada en la comparativa) — se deja como el primer ítem a resolver del roadmap de abajo.

## Checklist de "superficie de configuración por tenant" para un onboarding sin tocar código

Lo que un cliente nuevo necesitaría poder configurar (vía datos, no vía código) antes de operar:

1. Nombre/marca (`display_name`) — diseñado en [ADR-016](./fase-11-panel-admin-dashboard/adrs/ADR-016-parametrizacion-marca-tenant.md), falta implementar.
2. Identidad de negocio dentro del prompt (nombre, rubro, tono, alcance temático) — bloqueo central, ver arriba.
3. Moneda/locale de formato monetario — columna nueva en `tenants` (ej. `currency text default 'COP'`, `locale text default 'es-CO'`), consumida por `formatCOP()` (renombrar a algo genérico) y por el bloque de negocio del prompt.
4. Categorías de productos complementarios para recomendación — mover `COMPLEMENTARY_CATEGORIES` de `recomendarProducto.ts` a configuración por tenant, mismo patrón que `escalation_config` (jsonb con merge sobre un default vacío, no defaults de motos).
5. Credenciales/número de envío de WhatsApp por tenant — para que el `from` de `sendMessage.ts` no dependa de una única cuenta Twilio global.
6. Umbral de "monto alto" y reglas de escalamiento — **ya resuelto**, `escalation_config` es el patrón a seguir para todo lo demás de esta lista.
7. Link de cobro (si se retoma la idea de [Fase 12 #12](./fase-12-capacidades-proactivas-agente/analisis-superpoderes.md) con Payment Links de Stripe) — campo por tenant, ya anotado en la comparativa.

## Qué no cambia (decisiones de arquitectura que se mantienen)

- **No** se adopta el modelo de Forja de un despliegue/base de datos separada por cliente — sigue siendo un monolito compartido con RLS ([ADR-004](./fase-1-arquitectura/adrs/ADR-004-multi-tenancy-rls.md)), por las mismas razones ya documentadas en [comparativa-arquitectura-forja.md](./comparativa-arquitectura-forja.md#qué-desestimamos-y-por-qué-arquitectura-vs-priorización-vs-modelo-de-negocio).
- **No** se construye un "onboarding self-service" (que el propio cliente configure todo sin el equipo) en esta ronda — el checklist de arriba habilita que el equipo pueda onboardear un cliente nuevo por configuración, no que el cliente lo haga solo. Self-service es un paso posterior, no incluido aquí.

## Qué no resuelve este documento

Este es un mapa de lo que falta parametrizar, no una implementación. Cada ítem del checklist se convierte en su propia ADR/tarea cuando el negocio decida priorizar la incorporación de un segundo cliente real — momento en el que también hay que revisar la [Fase 10](../MASTER_PLAN.md#fase-10--preparación-para-escala-y-lanzamiento-multi-tenant) (infra) y [ADR-015](./fase-11-panel-admin-dashboard/adrs/ADR-015-alcance-autenticacion-panel.md) (autenticación por tenant, hoy diferida por la misma razón: un solo tenant real).
