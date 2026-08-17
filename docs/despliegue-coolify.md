# Despliegue en Coolify

Runbook del despliegue de agent-sale en Coolify, con dos entornos que
siguen a dos ramas:

| Entorno    | Rama      | Dominio             | Se despliega |
| ---------- | --------- | ------------------- | ------------ |
| production | `main`    | `app.formotos.com`  | Manual       |
| test       | `develop` | `test.formotos.com` | Automático   |

Producción es manual a propósito: un merge a `main` es una release, y una
release se decide, no se dispara sola. Test es automático porque su razón
de ser es ver `develop` corriendo sin pedir permiso a nadie.

## Topología

Coolify corre en la máquina de desarrollo, no en un VPS. La exposición
pública es por Cloudflare Tunnel: no hay puertos abiertos en el router ni
dependencia de la IP residencial, que es dinámica.

```
Internet
   │
   ▼
Cloudflare (DNS + TLS)
   │  app.formotos.com   ──┐
   │  test.formotos.com  ──┤
   ▼                       │
cloudflared (túnel saliente, sin puertos entrantes)
   │
   ▼
Traefik (proxy de Coolify, :80) ── enruta por Host
   ├── app  → contenedor production :3000
   └── test → contenedor test :3000
```

TLS lo termina Cloudflare, no Coolify: el túnel entrega tráfico plano a
Traefik en la red interna. Por eso **no** hay que activar Let's Encrypt
en los dominios de Coolify — el certificado nunca podría validarse, no
hay un `:80` alcanzable desde fuera.

Cada entorno tiene sus propios recursos, sin nada compartido:

- **Postgres** (`pgvector/pgvector:pg16` — la imagen por defecto de
  Coolify no trae pgvector y la migración `0001_extensions.cjs` falla)
- **Redis** (`redis:7-alpine`)
- **Aplicación** (build pack `dockerfile`, healthcheck en `/healthz`)

## Variables de entorno

Las mismas claves en ambos entornos, con valores distintos. Las que van
marcadas como secreto se guardan en Coolify con _Is Secret_ activo, que
las oculta del log de build.

| Variable                        | production                                   | test                                          |
| ------------------------------- | -------------------------------------------- | --------------------------------------------- |
| `DATABASE_URL`                  | rol `agent_sale_app` del Postgres de prod    | ídem, Postgres de test                        |
| `MIGRATIONS_DATABASE_URL`       | rol admin del Postgres de prod               | ídem, Postgres de test                        |
| `REDIS_URL`                     | Redis de prod (host interno de Coolify)      | Redis de test                                 |
| `PUBLIC_WEBHOOK_URL`            | `https://app.formotos.com/webhooks/whatsapp` | `https://test.formotos.com/webhooks/whatsapp` |
| `TENANT_SECRETS_ENCRYPTION_KEY` | 32 bytes base64, **propia del entorno**      | otra distinta                                 |
| `LLM_PROVIDER`                  | `anthropic` u `openai_compatible`            | ídem                                          |
| `ANTHROPIC_API_KEY` / `LLM_*`   | según el proveedor activo                    | ídem                                          |
| `NODE_ENV`                      | `production`                                 | `production`                                  |
| `PORT`                          | `3000`                                       | `3000`                                        |
| `LOG_LEVEL`                     | `info`                                       | `debug`                                       |

Notas que cuestan un incidente cada una:

- **`TENANT_SECRETS_ENCRYPTION_KEY` no se comparte entre entornos.** Cifra
  las credenciales de canal guardadas en `channel_connections`. Si test
  y producción comparten clave, un volcado de la base de test alcanza
  para descifrar los tokens de Meta de producción. Se genera con
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
  Y si se pierde o se rota, las credenciales ya guardadas dejan de
  descifrar: hay que volver a cargarlas desde el panel.
- **`DATABASE_URL` usa `agent_sale_app`, no el rol admin.** Ese rol lo crea
  la migración `0011_app_role.cjs` sin `SUPERUSER`, así que la aplicación
  no puede alterar el esquema. La contraseña que trae la migración es la
  de desarrollo: en cada entorno se cambia con `ALTER ROLE` una sola vez
  después de la primera migración (ver más abajo).
- **`PUBLIC_WEBHOOK_URL` no es solo el webhook.** De ahí salen también los
  enlaces de asesor y de reseña que recibe el cliente. Apuntarlo al
  dominio equivocado manda clientes de producción al entorno de test.
- **Las credenciales de Twilio y Meta ya no van en el entorno.** Desde la
  Fase 19 la fuente de verdad es la tabla `channel_connections`, que se
  edita en `/admin/conexiones`. Sin `TWILIO_*` la app arranca igual: la
  semilla `ensureConnectionsFromEnv()` no encuentra nada y no siembra.

## Migraciones

`npm run migrate` corre como **comando post-deploy** en Coolify, es decir
dentro del contenedor recién desplegado y antes de que reciba tráfico.
Usa `MIGRATIONS_DATABASE_URL` (rol admin), nunca `DATABASE_URL`.

Por eso `node-pg-migrate` es dependencia de producción y no de
desarrollo: la etapa runtime del Dockerfile instala con `--omit=dev`, y
con la dependencia del lado equivocado el binario no existe en la imagen.

### Después de la primera migración de cada entorno

La migración crea `agent_sale_app` con la contraseña de desarrollo. Una
vez, por entorno, desde el terminal del Postgres en Coolify:

```sql
ALTER ROLE agent_sale_app PASSWORD '<contraseña generada>';
```

y se actualiza `DATABASE_URL` con esa contraseña. El Postgres no está
expuesto fuera de la red interna de Docker, pero una contraseña conocida
y publicada en el repositorio no es una contraseña.

## Rutina de despliegue

**A test:** merge a `develop` → Coolify despliega solo.

**A producción:** siguiendo gitflow —

1. `release/vX.Y.Z` desde `develop`, PR a `main`, CI verde.
2. Merge del PR.
3. _Deploy_ manual en el entorno production de Coolify.
4. Retro-merge de la release a `develop` y tag `vX.Y.Z` sobre `main`.

Rollback: en Coolify, _Deployments_ → el despliegue anterior →
_Redeploy_. Ojo con las migraciones — una migración aplicada no se
revierte sola al volver a la imagen anterior; si el rollback la necesita,
`npm run migrate:down` va antes del redeploy.

## Verificación post-despliegue

```bash
curl -s https://app.formotos.com/healthz    # {"status":"ok"}
curl -s https://test.formotos.com/healthz
```

Un `521` de Cloudflare significa que el túnel está arriba pero el origen
no responde: casi siempre el contenedor caído o Traefik sin la ruta del
dominio. Un `530` es el túnel mismo caído (`cloudflared` no está
corriendo).

## Gotchas conocidos

- **La máquina es el servidor.** Si se apaga el equipo, los dos entornos
  caen. Es aceptable como piloto; producción de verdad pide un VPS. La
  configuración es portable: mismo repo, mismas variables, cambia el host.
- **`docker-compose` v1 está roto en esta máquina** — usar `docker compose`.
- **`docker-compose.yml` del repo es solo para desarrollo local.** Coolify
  no lo usa: cada entorno tiene sus recursos gestionados.
