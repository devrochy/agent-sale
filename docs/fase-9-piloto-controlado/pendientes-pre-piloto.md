# Pendientes pre-piloto

Las Fases 0-8 dejaron el diseño y el código completos, pero varias decisiones ya tomadas (ADRs aceptados) nunca se **ejecutaron** — siguen esperando una cuenta real, un pago, o una implementación que se pospuso. Esta fase no puede reportar "tráfico real" sin resolver esto primero: son la entrada de la Fase 9, no deuda suelta de fases anteriores.

Ninguno de estos ítems reabre una decisión de arquitectura (los ADRs ya están aceptados) — son ejecución pendiente.

## 1. Cuenta BSP real (WhatsApp Business API)

Ver [checklist-cuenta-bsp.md](../fase-3-whatsapp-gateway/checklist-cuenta-bsp.md) (Fase 3) — ningún ítem marcado todavía. Hoy la plataforma solo se probó contra el **Sandbox** de Twilio (mensajes con `join <palabra>`, sin plantillas aprobadas, sin número definitivo). Pasos:

- [ ] Cuenta Twilio con método de pago real (no trial).
- [ ] Meta Business Manager de ForMotos creado y verificado (documento legal, posible verificación de dominio).
- [ ] Definir el número (¿migrar el actual o uno nuevo? decisión del dueño del negocio, ver checklist).
- [ ] Plantillas de mensajes enviadas y aprobadas por Meta (puede tardar días — arrancar este trámite temprano en la fase, no al final).
- [ ] `PUBLIC_WEBHOOK_URL` apuntando al dominio real de producción (no un túnel de `cloudflared`), registrado en la consola de Twilio.

## 2. Hosting real (Fly.io)

ADR-005 ya decidió Fly.io. Falta ejecutarlo:

- [ ] Cuenta de Fly.io creada, `fly.toml` (ya existe en el repo) probado con un `flyctl deploy` real.
- [ ] `FLY_API_TOKEN` cargado como secret de GitHub — hoy el job `deploy-staging`/`deploy-production` de `.github/workflows/ci.yml` corre pero cae siempre en la rama "Deploy pendiente" por falta de este secret.
- [ ] Confirmar costo real (la condición explícita del estado "Aceptado" de ADR-005) con tráfico de prueba antes de comprometer presupuesto del piloto.
- [ ] Ambiente de producción de GitHub (`environment: production`) configurado con aprobación manual, como ya asume el workflow.

## 3. Postgres gestionado real (Supabase)

ADR-006 ya decidió Supabase (free tier), solo como base de datos. Falta ejecutarlo:

- [ ] Proyecto de Supabase creado, migraciones (`npm run migrate`) corridas contra esa base.
- [ ] Roles de aplicación (`agent_sale_app`) y admin (`agent_sale`) recreados con los mismos permisos mínimos que en local (ver `migrations/0011_app_role.cjs`).
- [ ] `DATABASE_URL`/`MIGRATIONS_DATABASE_URL` de producción cargados como secrets, nunca en texto plano.
- [ ] TLS forzado verificado contra el host real de Supabase (el heurístico de `src/shared/db/pool.ts`, Fase 8, ya lo activa para hosts no-`localhost` — confirmar que efectivamente negocia TLS contra Supabase).
- [ ] Una vez alcanzable, conectar el datasource Postgres de Grafana para el panel de negocio (ADR-011, quedó explícitamente bloqueado por esto).

## 4. Proveedor de LLM de producción

ADR-008 decidió Claude como LLM de producción. Hoy se opera con DeepSeek (`LLM_PROVIDER=openai_compatible`) por un pago rechazado en la cuenta de Anthropic — decisión temporal, no un cambio de ADR-008.

- [ ] Resolver el método de pago de Anthropic y confirmar `ANTHROPIC_API_KEY` real funcional.
- [ ] Si el piloto necesita arrancar antes de resolver esto, **decisión explícita del negocio** (no asumida): ¿arranca sobre DeepSeek temporalmente, documentando el riesgo de calidad/comportamiento distinto al validado en diseño, o se espera a tener Claude? Registrar la decisión que se tome acá antes de empezar el piloto.

## 5. Catálogo real de ForMotos

Ver [ADR-013](./adrs/ADR-013-mecanismo-catalogo-piloto.md) — se usa el panel admin ya construido, no el sync con Sheets diseñado en la Fase 5.

- [ ] Confirmar con el dueño de ForMotos que acepta cargar/mantener el catálogo desde el panel admin en vez de su Sheet actual (riesgo de adopción, ver README de esta fase).
- [ ] Cargar el catálogo real (~300+ productos, precios, stock) — reemplaza los datos de prueba de `scripts/seed-catalogo-prueba.ts`.
- [ ] Confirmar reglas de promociones reales (temporada, por volumen) — la Fase 0 dejó el porcentaje exacto de cada tramo como pendiente menor, todavía sin cerrar.

## 6. Validación del umbral de escalamiento por monto

[reglas-escalamiento.md](../fase-7-escalamiento-humano/reglas-escalamiento.md) (Fase 7) dejó el umbral de "monto alto" como propuesta inicial. No bloquea el arranque del piloto — se valida y ajusta **con datos reales durante** el piloto, no antes. Se anota acá para no perderlo de vista en el [reporte final](./criterios-y-reporte.md).

## Orden sugerido

1 y 4 (BSP y LLM) son los más largos en tiempo de espera externo (aprobación de Meta, trámite de pago) — arrancarlos primero, en paralelo con el resto. 2 y 3 (Fly.io, Supabase) son ejecución rápida una vez creada la cuenta. 5 depende de una conversación con el dueño del negocio, no de trabajo técnico.
