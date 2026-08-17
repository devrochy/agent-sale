# Guía de ejecución local

Manual paso a paso para levantar `agent-sale` en una máquina nueva: desde
cero (sin cuentas, sin `.env`) hasta tener un mensaje de WhatsApp real
respondido por el agente y visible en Grafana Cloud.

Es un documento vivo — se actualiza a medida que cambian las herramientas,
credenciales o comandos. Si un paso deja de funcionar como está escrito
acá, corregilo en el mismo commit que corrige el problema.

---

## 0. Prerrequisitos

| Herramienta | Verificar con | Notas |
|---|---|---|
| Node.js | `node -v` | v24.x en esta máquina; el proyecto no fija versión en `.nvmrc` |
| Docker + Docker Compose | `docker -v` / `docker-compose -v` | Para Postgres, Redis y (opcional) Alloy |
| `gh` (GitHub CLI) | `gh auth status` | Solo si vas a mergear/revisar PRs |
| `cloudflared` | `cloudflared -v` | Solo para exponer el webhook a Twilio con WhatsApp real |
| Cuenta de Twilio (WhatsApp Sandbox) | — | Gratis, ver paso 5 |
| Cuenta de Grafana Cloud (free tier) | — | Solo si vas a probar observabilidad, ver paso 6 |
| Cuenta de Anthropic o DeepSeek | — | Al menos una, para que el orquestador pueda llamar al LLM |

---

## 1. Clonar e instalar dependencias

```bash
git clone <repo>
cd agent-sale
npm install
```

---

## 2. Variables de entorno

```bash
cp .env.example .env
```

Completar en `.env` (nunca se commitea — está en `.gitignore`):

### 2.1 Base de datos y Redis

Los valores por defecto de `.env.example` ya coinciden con las
credenciales del `docker-compose.yml` de este repo — no hace falta
tocarlos para desarrollo local.

### 2.2 Proveedor de LLM

Elegí uno:

- **Anthropic (Claude, decisión de producción — ADR-008)**:
  ```
  LLM_PROVIDER=anthropic
  ANTHROPIC_API_KEY=sk-ant-...
  ```
- **DeepSeek u otro compatible con OpenAI** (más barato para pruebas
  manuales; ver `project_deepseek_temporal` — es temporal, no reemplaza
  la decisión de producción):
  ```
  LLM_PROVIDER=openai_compatible
  LLM_API_KEY=sk-...
  # LLM_BASE_URL=https://api.deepseek.com   (default si no se setea)
  # LLM_MODEL=deepseek-chat                 (default si no se setea)
  ```

### 2.3 Twilio (WhatsApp)

Ver paso 5 para conseguir estos valores.

```
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886   # número del Sandbox
PUBLIC_WEBHOOK_URL=http://localhost:3000/webhooks/whatsapp   # se actualiza en el paso 5.3
```

### 2.4 Observabilidad (opcional — ver paso 6)

```
LOG_LEVEL=info
GRAFANA_CLOUD_LOKI_URL=
GRAFANA_CLOUD_LOKI_USER=
GRAFANA_CLOUD_LOKI_API_KEY=
```

---

## 3. Levantar infraestructura local (Postgres + Redis)

```bash
docker-compose up -d
npm run migrate
```

Verificar que las migraciones corrieron bien:

```bash
docker exec -it agent-sale_postgres_1 psql -U agent_sale -d agent_sale -c '\dt'
```

---

## 4. Levantar la app y probar con un mensaje simulado

Esto **no** requiere Twilio ni túnel — encola un mensaje directo en Redis,
saltándose el webhook.

```bash
# Terminal 1: la app
npx tsx src/index.ts

# Terminal 2: siembra un tenant/producto de prueba y un mensaje
npm run manual:seed-test-message -- "Hola, tienen cascos?"
```

En la Terminal 1 deberías ver la cadena de eventos del orquestador
(`orchestrator.mensaje_tomado` → `orchestrator.llm_iniciado` →
`orchestrator.llm_completado` → ... → `orchestrator.respuesta_lista`).

---

## 5. Probar con WhatsApp real (Twilio Sandbox)

### 5.1 Crear el Sandbox

1. [console.twilio.com](https://console.twilio.com) → crear cuenta (trial gratis).
2. **Messaging → Try it out → Send a WhatsApp message** → activa el
   Sandbox y te da un número (`whatsapp:+14155238886`) y una palabra
   clave (`join <palabra>`) que mandás desde tu WhatsApp para conectarte.
3. Copiar `Account SID` y `Auth Token` del dashboard principal a `.env`
   (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`).

### 5.2 Registrar un tenant con el número real del Sandbox

El webhook busca el tenant por `To` (el número del Sandbox). Si el único
tenant en tu DB tiene un `whatsapp_number` de prueba (como el que siembra
`seed-manual-test.ts`), el mensaje real **no vas a ver nada en el log** —
el handler corta en silencio con `unknown_tenant` para evitar reintentos
de Twilio (`src/gateway/webhookHandler.ts`). Hay que asegurarse de que
algún tenant tenga `whatsapp_number = 'whatsapp:+14155238886'` (o el
número que te haya asignado tu Sandbox).

```sql
update tenants set whatsapp_number = 'whatsapp:+14155238886' where id = '<tenant-id>';
```

### 5.3 Exponer el webhook con un túnel

```bash
cloudflared tunnel --url http://localhost:3000
```

Copiar la URL que imprime (`https://<random>.trycloudflare.com`) y:

1. Actualizar `.env`:
   ```
   PUBLIC_WEBHOOK_URL=https://<random>.trycloudflare.com/webhooks/whatsapp
   ```
2. **Reiniciar la app** — `PUBLIC_WEBHOOK_URL` se lee una sola vez al
   arrancar y se usa para validar la firma de Twilio
   (`src/gateway/twilioSignature.ts`). Si quedó desactualizada, Twilio
   recibe `403 invalid_signature` sin que se note por qué.
3. En la consola de Twilio → Sandbox settings → **"When a message comes
   in"** → pegar la misma URL. El Sandbox no tiene API para esto, es
   manual cada vez que cambia la URL del túnel.

> El túnel gratis (`trycloudflare.com`) genera una URL nueva cada vez que
> se reinicia — repetir este paso completo si reiniciás `cloudflared`.

### 5.4 Mandar el mensaje

Desde el WhatsApp que uniste al Sandbox, mandá cualquier texto. Debería
verse la misma cadena de eventos del paso 4 en el log de la app.

---

## 6. Observabilidad local (Grafana Cloud + Loki + Alloy)

Ver también `observability/README.md` (referencia técnica del pipeline).
Acá está el paso a paso end-to-end.

### 6.1 Cuenta de Grafana Cloud

1. [grafana.com/auth/sign-up/create-user](https://grafana.com/auth/sign-up/create-user) — plan free, sin tarjeta.
2. Al terminar el onboarding tenés un stack (`tu-usuario.grafana.net`).
3. **Connections → Add new connection → Loki** (o "Hosted logs").
4. Copiar:
   - **endpoint de push**: `https://logs-prod-XXX.grafana.net/loki/api/v1/push`
   - **user** (numérico)
   - Generar un **Access Policy Token** con scope `logs:write` (alcanza
     para enviar logs; **no** sirve para consultarlos por API — la
     consulta se hace con tu login normal en la UI, ver 6.4).

### 6.2 Cargar credenciales en `.env`

```
GRAFANA_CLOUD_LOKI_URL=https://logs-prod-XXX.grafana.net/loki/api/v1/push
GRAFANA_CLOUD_LOKI_USER=123456
GRAFANA_CLOUD_LOKI_API_KEY=glc_...
```

Estas variables **no** las usa la app — solo las lee el contenedor de
Alloy (`docker-compose.observability.yml`).

### 6.3 Generar logs y levantar Alloy

```bash
# La app, redirigiendo stdout al archivo que Alloy vigila:
npx tsx src/index.ts > observability/logs/app.log 2>&1 &

# Alloy, además de Postgres/Redis:
docker-compose -f docker-compose.yml -f docker-compose.observability.yml up -d alloy
```

Generar tráfico (mensaje real de WhatsApp — paso 5 — o
`npm run manual:seed-test-message`) para que haya líneas que enviar.

Verificar que Alloy no tiene errores de envío: `http://localhost:12345`.

### 6.4 Verificar en Grafana Cloud

En tu cuenta de Grafana Cloud → **Explore** → datasource Loki → query
`{app="agent-sale"}`. Deberías ver las líneas JSON del log correlacionadas
por `tenant_id`/`conversation_id`.

### 6.5 Importar el dashboard

**Dashboards → New → Import** → subir `observability/dashboard.json` →
elegir tu datasource de Loki. Las consultas LogQL son un punto de partida
(basadas en `docs/fase-8-observabilidad-seguridad/tracing.md`).

---

## 7. Tests y build (antes de abrir/actualizar un PR)

```bash
npm run lint
npm test              # unitarios
npm run test:integration
npm run build
```

Los tests de integración golpean Postgres/Redis reales de
`docker-compose.yml` — deben estar arriba y migrados (pasos 3).

---

## 8. Reset completo del entorno

Cuando el estado local queda inconsistente (datos de prueba viejos,
conflictos de constraint únicos, etc.):

```bash
# Incluir el compose de observabilidad si Alloy está corriendo, o falla
# por "network has active endpoints".
docker-compose -f docker-compose.yml -f docker-compose.observability.yml down --volumes --remove-orphans

# Verificar que el volumen de Postgres realmente se borró (a veces un
# down -v interrumpido antes deja el volumen intacto pese a reportar éxito):
docker volume rm agent-sale_agent_sale_pg_data   # "no such volume" = ya estaba limpio, ok

docker-compose up -d
npm run migrate
```

Si la app ya estaba corriendo, **reiniciá el proceso** después del reset:
el consumer de Redis Streams queda con el consumer group viejo en memoria
y falla con errores tipo `NOGROUP` contra el stream recién recreado.

---

## Troubleshooting (casos ya vistos)

| Síntoma | Causa | Fix |
|---|---|---|
| Mensaje real de WhatsApp no genera ningún log | Tenant sin `whatsapp_number` real registrado → `unknown_tenant`, corta en silencio | Paso 5.2 |
| Twilio devuelve error / nada llega tras cambiar el túnel | `PUBLIC_WEBHOOK_URL` desactualizada, falla la validación de firma | Reiniciar la app tras actualizar `.env` (paso 5.3) |
| `duplicate key value violates unique constraint "tenants_whatsapp_number_key"` en tests de integración | Datos de prueba de una corrida anterior no se limpiaron | Reset completo (paso 8) |
| `docker-compose down -v` falla con "network has active endpoints" | El contenedor de Alloy sigue conectado a la red compartida | Bajar ambos compose files juntos (paso 8) |
| Consumer de Redis con errores tras un reset | El proceso de la app sigue con el consumer group viejo en memoria | Reiniciar la app |
| `curl` contra `/loki/api/v1/query_range` devuelve `401 invalid scope requested` | El Access Policy Token tiene scope `logs:write`, no `logs:read` | Verificar en la UI de Grafana Explore (login propio), no por API con ese token |
