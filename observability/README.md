# Observabilidad local (Grafana Cloud)

Prueba local del pipeline de logs → Grafana Cloud (ADR-009), mientras no
existe todavía un despliegue real en Fly.io que decida el mecanismo de
producción. Usa [Grafana Alloy](https://grafana.com/docs/alloy/) como
agente que lee un archivo de log local y lo envía a Loki.

Requiere el logging estructurado de la Fase 8
(`src/shared/observability/logger.ts`, mergeado a `develop` vía PRs
#20/#21/#22).

## 1. Cuenta de Grafana Cloud (free tier)

1. [grafana.com/auth/sign-up/create-user](https://grafana.com/auth/sign-up/create-user) — plan gratuito, sin tarjeta.
2. Al terminar el onboarding ya tenés un stack (`tu-usuario.grafana.net`).
3. En el panel de tu cuenta: **Connections → Add new connection → Loki** (o `Hosted logs`).
4. Copiá el **endpoint de push** (`https://logs-prod-XXX.grafana.net/loki/api/v1/push`), el **user** (numérico) y generá un **Access Policy Token** con scope `logs:write`.

## 2. Configurar credenciales

En tu `.env` (no se commitea):

```
GRAFANA_CLOUD_LOKI_URL=https://logs-prod-XXX.grafana.net/loki/api/v1/push
GRAFANA_CLOUD_LOKI_USER=123456
GRAFANA_CLOUD_LOKI_API_KEY=glc_...
```

## 3. Generar logs locales y levantar Alloy

```bash
# Corré la app (desde una rama con logger.ts) redirigiendo stdout al
# archivo que Alloy vigila:
npx tsx src/index.ts > observability/logs/app.log 2>&1 &

# Alloy, además de Postgres/Redis:
docker-compose -f docker-compose.yml -f docker-compose.observability.yml up -d alloy
```

Generá tráfico real (`npm run manual:seed-test-message` o un mensaje real
de WhatsApp si ya tenés Twilio configurado) para que haya líneas de log
que enviar.

Interfaz de Alloy (para confirmar que el componente `loki.write` no tiene
errores de envío): `http://localhost:12345`.

## 4. Importar el dashboard

En Grafana Cloud: **Dashboards → New → Import**, subí `dashboard.json` de
esta carpeta, y elegí tu datasource de Loki cuando lo pida. Las consultas
LogQL son un punto de partida (basadas en `tracing.md`) — quedan por
verificar contra datos reales: en particular el panel de tokens usa
`| json input_tokens="usage.inputTokens"` para extraer el campo anidado
`usage.inputTokens` que emite `orchestrator.llm_completado`; si no
aparece, revisar en **Explore** cómo Loki está parseando esa línea.

## Qué no cubre esto

- El mecanismo de envío en producción (Fly.io → Loki) — decisión abierta
  en ADR-009, a resolver cuando exista un despliegue real.
- Las alertas de costo por tenant (`alertas-costo.md`) — quedan para
  cuando el dashboard esté validado con datos reales.
