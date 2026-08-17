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

Coolify corre en la máquina de desarrollo, no en un VPS.

```
Traefik (proxy de Coolify, :80) ── enruta por Host
   ├── app.formotos.com   → contenedor production :3000
   └── test.formotos.com  → contenedor test :3000
```

Los dos dominios ya están declarados en Coolify y Traefik enruta por
`Host`, pero **todavía no son alcanzables desde Internet**: falta la
exposición pública (ver más abajo). Mientras tanto, cada entorno se
alcanza en la red local por el dominio `*.sslip.io` que Coolify generó.

### Exposición pública: pendiente

El plan es Cloudflare Tunnel — sin puertos abiertos en el router ni
dependencia de la IP residencial, que es dinámica. Está bloqueado por el
DNS, no por Coolify:

`formotos.com` delega en `daphne/jake.ns.cloudflare.com`, nameservers de
una cuenta de Cloudflare de terceros (quien administra el sitio en
45.32.174.19). La zona en la cuenta propia está en estado `pending`,
esperando `amir/gene.ns.cloudflare.com`. Y Cloudflare solo permite
enlazar un túnel con hostnames de zonas de **la misma cuenta**: sin
redelegar los nameservers no hay forma de publicar `app.formotos.com`
por el túnel.

Redelegar no es gratis, y por eso está en pausa: en esa zona vive el
correo (MX de Zoho, SPF, DKIM en `default._domainkey` y
`mail._domainkey`, DMARC) y cuatro subdominios _proxied_ —`test`,
`mail`, `ftp`, `webmail`— cuyo origen real no se puede leer desde fuera.
Moverla a ciegas es arriesgarse a tumbar el correo.

Cuando se retome, el orden es:

1. Conseguir el export de la zona actual (Cloudflare lo genera en un
   clic) o acceso de miembro a esa cuenta.
2. Replicar la zona completa en la cuenta propia, con los registros
   _proxied_ resueltos a su origen real.
3. Cambiar los nameservers en el registrador a `amir/gene`.
4. Crear el túnel, sus dos public hostnames apuntando a
   `http://172.18.0.1:80`, y los CNAME de `app.` y `test.` al túnel.

TLS lo terminará Cloudflare, no Coolify: el túnel entrega tráfico plano
a Traefik. Por eso **no** hay que activar Let's Encrypt en los dominios
de Coolify — el certificado nunca podría validarse, no hay un `:80`
alcanzable desde fuera.

Consecuencia mientras tanto: `PUBLIC_WEBHOOK_URL` apunta al dominio
definitivo, así que los webhooks entrantes de Meta/Twilio no llegan y
los enlaces de asesor y de reseña que recibe el cliente no abren. Los
entornos sirven para todo lo demás.

Cada entorno tiene sus propios recursos, sin nada compartido:

- **Postgres** (`pgvector/pgvector:pg17` — la imagen por defecto de
  Coolify no trae pgvector y la migración `0001_extensions.cjs` falla.
  Local y CI usan pg16; la diferencia de versión mayor no afecta a
  ninguna migración, pero conviene recordarla al depurar)
- **Redis** (`redis:7.2`)
- **Aplicación** (build strategy `Dockerfile`, healthcheck HTTP en
  `/healthz` puerto 3000, con 30 s de gracia de arranque)

## Variables de entorno

Las mismas claves en ambos entornos, con valores distintos. Las que van
marcadas como secreto se guardan en Coolify con _Is Secret_ activo, que
las oculta del log de build.

| Variable                        | production                                   | test                                          |
| ------------------------------- | -------------------------------------------- | --------------------------------------------- |
| `DATABASE_URL`                  | rol `agent_sale_app` del Postgres de prod    | ídem, Postgres de test                        |
| `MIGRATIONS_DATABASE_URL`       | rol `agent_sale_migrations` de prod          | ídem, Postgres de test                        |
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
- **`DATABASE_URL` usa `agent_sale_app`, no un rol con DDL.** La
  aplicación no puede alterar el esquema ni saltarse nada; ver "Los tres
  roles de Postgres" más abajo.
- **`PUBLIC_WEBHOOK_URL` no es solo el webhook.** De ahí salen también los
  enlaces de asesor y de reseña que recibe el cliente. Apuntarlo al
  dominio equivocado manda clientes de producción al entorno de test.
- **Las credenciales de Twilio y Meta ya no van en el entorno.** Desde la
  Fase 19 la fuente de verdad es la tabla `channel_connections`, que se
  edita en `/admin/conexiones`. Sin `TWILIO_*` la app arranca igual: la
  semilla `ensureConnectionsFromEnv()` no encuentra nada y no siembra.

## Migraciones

`npm run migrate` está configurado como **comando pre-deployment** en
Coolify: corre con la imagen nueva antes de que arranque el contenedor
que va a servir tráfico. Tiene que ser antes y no después porque la app
consulta `channel_connections` en el arranque (`ensureConnectionsFromEnv`):
con el esquema sin migrar, el proceso muere antes de escuchar en el
puerto. Usa `MIGRATIONS_DATABASE_URL`, nunca `DATABASE_URL`.

Por eso `node-pg-migrate` es dependencia de producción y no de
desarrollo: la etapa runtime del Dockerfile instala con `--omit=dev`, y
con la dependencia del lado equivocado el binario no existe en la imagen.

### Los tres roles de Postgres

Cada entorno tiene tres roles, y ninguno de los dos que usa la aplicación
es el que Coolify autogenera:

| Rol                     | Quién lo usa               | Privilegios            |
| ----------------------- | -------------------------- | ---------------------- |
| `postgres`              | solo Coolify (backups, UI) | superusuario           |
| `agent_sale_migrations` | `MIGRATIONS_DATABASE_URL`  | superusuario           |
| `agent_sale_app`        | `DATABASE_URL`             | sin DDL, sin superuser |

La contraseña maestra de Coolify no aparece en ninguna variable de la
aplicación: si mañana hay que rotar las credenciales de la app, se hace
con un `ALTER ROLE` sobre esos dos roles sin tocar lo que Coolify usa
para sus backups.

`agent_sale_app` se crea a mano **antes** de la primera migración, con
una contraseña generada. La migración `0011_app_role.cjs` lo detecta con
`IF NOT EXISTS` y solo le aplica los `GRANT`, así que nunca llega a
usarse la contraseña de desarrollo que trae esa migración escrita.

```sql
CREATE ROLE agent_sale_app LOGIN PASSWORD '<generada>' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE agent_sale_migrations LOGIN SUPERUSER PASSWORD '<generada>';
```

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

Mientras la exposición pública siga pendiente, esos dos `curl` no van a
responder desde fuera: verificar contra el dominio `*.sslip.io` de cada
entorno, desde la propia máquina.

Cuando el túnel esté activo, un `521` de Cloudflare significa que el
túnel está arriba pero el origen no responde (casi siempre el contenedor
caído o Traefik sin la ruta del dominio), y un `530` que el túnel mismo
está caído (`cloudflared` no corriendo).

## Gotchas conocidos

- **La máquina es el servidor.** Si se apaga el equipo, los dos entornos
  caen. Es aceptable como piloto; producción de verdad pide un VPS. La
  configuración es portable: mismo repo, mismas variables, cambia el host.
- **La zona de Cloudflare tiene que estar activa, y ser la correcta.** El
  dominio delega en `daphne/jake.ns.cloudflare.com`; si en la cuenta desde
  la que se administra el túnel la zona aparece en estado `pending` con
  otros nameservers asignados, es una zona distinta: los registros que se
  creen ahí no los sirve nadie. Verificar con
  `curl -H "Authorization: Bearer $TOKEN" ".../zones?name=formotos.com"`
  que `status` sea `active` antes de tocar DNS.
- **`docker-compose` v1 está roto en esta máquina** — usar `docker compose`.
- **`docker-compose.yml` del repo es solo para desarrollo local.** Coolify
  no lo usa: cada entorno tiene sus recursos gestionados.
