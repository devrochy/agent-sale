# Despliegue en Coolify

Runbook del despliegue de agent-sale en Coolify, con dos entornos que
siguen a dos ramas:

| Entorno    | Rama      | Dominio             | Se despliega |
| ---------- | --------- | ------------------- | ------------ |
| production | `main`    | `app.formotos.com`  | Manual       |
| test       | `develop` | `test.formotos.com` | Manual       |

Producción es manual a propósito: un merge a `main` es una release, y una
release se decide, no se dispara sola. Test también lo es hoy, pero por
una limitación, no por diseño: el auto-deploy necesita que GitHub pueda
llamar a Coolify por webhook, y Coolify no está publicado en Internet
(ver "Exposición pública").

Coolify corre en la máquina de desarrollo, no en un VPS. Si se apaga el
equipo, los dos entornos caen con él. Es aceptable como piloto;
producción de verdad pide un servidor aparte. La configuración es
portable: mismo repo, mismas variables, cambia el host.

## Recursos de cada entorno

```
Traefik (proxy de Coolify, :80/:443) ── enruta por Host
   ├── app.formotos.com   → contenedor production :3000
   └── test.formotos.com  → contenedor test :3000
```

Nada compartido entre entornos:

- **Postgres** — imagen `pgvector/pgvector:pg17`. La imagen por defecto de
  Coolify no trae pgvector y `0001_extensions.cjs` falla. Local y CI usan
  pg16; la diferencia de versión mayor no afecta a ninguna migración, pero
  conviene recordarla al depurar.
- **Redis** — `redis:7.2`.
- **Aplicación** — build strategy `Dockerfile`, healthcheck HTTP a
  `127.0.0.1:3000/healthz` con 30 s de gracia, migraciones como comando
  pre-deployment.

## Variables de entorno

Las mismas claves en ambos entornos, con valores distintos:

| Variable                        | production                                   | test                            |
| ------------------------------- | -------------------------------------------- | ------------------------------- |
| `DATABASE_URL`                  | rol `agent_sale_app` del Postgres de prod    | ídem, Postgres de test          |
| `MIGRATIONS_DATABASE_URL`       | rol `agent_sale_migrations` de prod          | ídem, Postgres de test          |
| `REDIS_URL`                     | Redis de prod (host interno de Coolify)      | Redis de test                   |
| `PUBLIC_WEBHOOK_URL`            | `https://app.formotos.com/webhooks/whatsapp` | la URL pública real del entorno |
| `TENANT_SECRETS_ENCRYPTION_KEY` | 32 bytes base64, **propia del entorno**      | otra distinta                   |
| `LLM_PROVIDER`                  | `anthropic` u `openai_compatible`            | ídem                            |
| `ANTHROPIC_API_KEY` / `LLM_*`   | según el proveedor activo                    | ídem                            |
| `NODE_ENV`                      | `production` (**solo runtime**, ver abajo)   | ídem                            |
| `PORT`                          | `3000`                                       | `3000`                          |
| `LOG_LEVEL`                     | `info`                                       | `debug`                         |

Notas que cuestan un incidente cada una:

- **`NODE_ENV` va marcada "Not available during build".** Coolify inyecta
  las variables de la aplicación también en el build, y con
  `NODE_ENV=production` npm se salta las devDependencies: `npm run build`
  muere con `tsc: not found`. El Dockerfile instala con `--include=dev`
  para no depender de esa casilla, pero conviene dejarla bien igualmente.
- **`TENANT_SECRETS_ENCRYPTION_KEY` no se comparte entre entornos.** Cifra
  las credenciales de canal de `channel_connections`. Si test y producción
  comparten clave, un volcado de la base de test alcanza para descifrar
  los tokens de Meta de producción. Se genera con
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
  Si se pierde o se rota, las credenciales guardadas dejan de descifrar:
  hay que volver a cargarlas desde el panel.
- **`PUBLIC_WEBHOOK_URL` no es solo el webhook.** De ahí salen también los
  enlaces de asesor y de reseña que recibe el cliente, y de su `origin`
  sale la URL del webhook de Meta (`/webhooks/meta`). Apuntarla al dominio
  equivocado manda clientes de producción al entorno de test.
- **Las credenciales de Twilio y Meta ya no van en el entorno.** Desde la
  Fase 19 la fuente de verdad es `channel_connections`, que se edita en
  `/admin/conexiones`. Sin `TWILIO_*` la app arranca igual.

### Los tres roles de Postgres

Ninguno de los dos roles que usa la aplicación es el que Coolify
autogenera:

| Rol                     | Quién lo usa               | Privilegios            |
| ----------------------- | -------------------------- | ---------------------- |
| `postgres`              | solo Coolify (backups, UI) | superusuario           |
| `agent_sale_migrations` | `MIGRATIONS_DATABASE_URL`  | superusuario           |
| `agent_sale_app`        | `DATABASE_URL`             | sin DDL, sin superuser |

Así la contraseña maestra de Coolify no entra en ninguna variable de la
app: rotar las credenciales de la aplicación es un `ALTER ROLE` sobre esos
dos roles, sin tocar lo que Coolify usa para sus backups.

`agent_sale_app` se crea **antes** de la primera migración.
`0011_app_role.cjs` lo detecta con `IF NOT EXISTS` y solo le aplica los
`GRANT`, así que nunca se usa la contraseña de desarrollo que trae escrita:

```sql
CREATE ROLE agent_sale_app LOGIN PASSWORD '<generada>' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE agent_sale_migrations LOGIN SUPERUSER PASSWORD '<generada>';
```

## Arranque en frío de un entorno nuevo

Un entorno recién creado **no arranca solo**. Estos tres pasos no los hace
ninguna migración ni el código, y sin ellos el panel devuelve 404 en el
login sin explicar por qué:

**1. Migraciones.** Ver la sección siguiente: en el primer despliegue el
comando pre-deployment se salta, así que hay que correrlas a mano una vez.

**2. La fila de `settings`.** La tabla es singleton y **nace vacía**:
`0036_drop_multitenancy.cjs` convierte el tenant existente en la fila de
settings, y en una base nueva no hay ninguno. Sin esa fila,
`renderLoginPage()` devuelve `null` y `/login` responde **404**:

```sql
INSERT INTO settings (name, display_name) VALUES ('ForMotos', 'ForMotos (test)');
```

**3. El primer admin.** No hay registro ni bootstrap: `createAdmin` solo se
invoca desde el panel, y al panel no se entra sin admin. El hash es scrypt
en formato `<salt_hex>:<hash_hex>`, 16 bytes de salt y 64 de clave:

```bash
read -rsp "Contraseña: " PW && echo
APP=$(docker ps --format '{{.Names}}' | grep <uuid-app> | head -1)
HASH=$(docker exec -e PW="$PW" "$APP" node -e 'const{randomBytes,scryptSync}=require("crypto");const s=randomBytes(16);console.log(s.toString("hex")+":"+scryptSync(process.env.PW,s,64).toString("hex"))')
docker exec -i <uuid-postgres> psql -U postgres -d agent_sale <<SQL
INSERT INTO admins (username,email,password_hash,role) VALUES ('rochy','tu@correo','$HASH','master');
INSERT INTO admin_permissions (admin_id) SELECT id FROM admins WHERE username='rochy';
SQL
unset PW
```

**Las dos filas hacen falta.** `findAdminByUsernameOrEmail` consulta
`FROM admins a JOIN admin_permissions p ON p.admin_id = a.id` — un INNER
JOIN—, así que un admin sin su fila de permisos no existe para el login:
la contraseña es correcta, el hash verifica, y aun así responde **401 sin
un solo error en los logs**. `createAdmin()` inserta ambas dentro de la
misma transacción; a mano hay que acordarse.

El panel vive en **`/login`**, no en `/`: la raíz no tiene ruta y responde 404. `/admin` redirige a `/login`.

## Migraciones

Las migraciones corren **en el arranque del contenedor**, no como comando
de despliegue de Coolify: el `CMD` del Dockerfile es
`npm run migrate && node dist/src/index.js`.

Tiene que ser así porque **Coolify ejecuta su comando pre-deployment dentro
del contenedor anterior**, que corre la imagen vieja. Sus `migrations/` no
incluyen las de la versión que se está desplegando, así que informa
`No migrations to run!` y la app nueva arranca contra un esquema atrasado
y muere. Pasó en los dos entornos, y en producción con la `0054`.

Con el `CMD` el orden queda garantizado: si `migrate` falla, el proceso no
llega a escuchar, el healthcheck no pasa y Coolify revierte — mejor eso que
servir tráfico con el esquema viejo.

`node-pg-migrate` es dependencia de producción por esto mismo: la etapa
runtime del Dockerfile instala con `--omit=dev`, y del lado equivocado el
binario no existe en la imagen.

> **Verificar el conteo de migraciones sigue siendo buena idea** después de
> un despliegue con migraciones nuevas, sobre todo en entornos que todavía
> tengan configurado el viejo comando pre-deployment:
>
> ```bash
> docker exec <uuid-postgres> psql -U postgres -d agent_sale -tAc "SELECT count(*) FROM pgmigrations;"
> git ls-tree --name-only origin/develop migrations/ | wc -l
> ```
>
> Si no coinciden, migrar a mano con la imagen ya construida:
>
> ```bash
> docker run --rm --network coolify --env-file <entorno>.env <imagen> npm run migrate
> ```

## Exposición pública

### Lo que está en uso: Tailscale Funnel

`https://devrochy.tail2ad60a.ts.net` publica el entorno de test. El Funnel
apunta **directo al contenedor**, sin pasar por Traefik:

```
Internet → Tailscale (termina TLS) → 127.0.0.1:3000 → contenedor de test
```

Se monta así:

1. En la aplicación, **Port mappings**: `127.0.0.1:3000:3000`. Atado a
   loopback: no queda expuesto en la red local, solo el Funnel llega.
2. `sudo tailscale funnel --bg 3000`.
3. `PUBLIC_WEBHOOK_URL` apuntando a `https://<nodo>.ts.net/...`.

Se intentó primero enrutar por Traefik declarando el hostname como dominio
en Coolify, y no compensa: el formulario obliga a elegir protocolo, y con
`https` Traefik redirige a HTTPS un tráfico que el Funnel ya entrega
descifrado — bucle de redirección. Con la vía directa hay menos piezas.

**El precio:** un solo entorno a la vez puede estar en el Funnel (el que
publique el 3000), y Meta solo acepta webhooks en el puerto 443, así que
no hay forma de repartirlo por puertos.

Comprobaciones útiles:

```bash
tailscale funnel status                     # a qué apunta
curl -s https://<nodo>.ts.net/healthz       # desde FUERA del tailnet
```

Probarlo desde la propia máquina o desde otro nodo del tailnet no vale: el
tráfico va por la red interna y no ejercita el Funnel. Hay que usar el
móvil con datos y Tailscale apagado.

### Lo que está bloqueado: Cloudflare Tunnel

Sería la opción preferible —dominio propio, varios hostnames a la vez— y
está bloqueada por el DNS, no por Coolify:

`formotos.com` delega en `daphne/jake.ns.cloudflare.com`, nameservers de
**otra cuenta** de Cloudflare (la de quien administra el sitio en
45.32.174.19). En la cuenta propia la zona figura en estado `pending`,
esperando `amir/gene.ns.cloudflare.com`. Y **un túnel solo enlaza
hostnames de zonas de su misma cuenta**, así que sin redelegar los
nameservers no hay forma de publicar `app.formotos.com` por túnel.

Redelegar no es gratis: en esa zona vive el correo (MX de Zoho, SPF, DKIM
en `default._domainkey` y `mail._domainkey`, DMARC) y cuatro subdominios
_proxied_ —`test`, `mail`, `ftp`, `webmail`— cuyo origen real no se puede
leer desde fuera. Moverla a ciegas es arriesgarse a tumbar el correo.

Cuando se retome, el orden es:

1. Conseguir el export de la zona actual (Cloudflare lo genera en un clic)
   o acceso de miembro a esa cuenta. **No reconstruirla a ojo.**
2. Replicar la zona completa en la cuenta propia, con los registros
   _proxied_ resueltos a su origen real.
3. Cambiar los nameservers en el registrador a `amir/gene`.
4. Crear el túnel y sus public hostnames apuntando a `http://172.18.0.1:80`
   (el Traefik de Coolify), y los CNAME de `app.` y `test.` al túnel.

El API token de Cloudflare necesita tres permisos, y el primero es el que
se olvida: `Account → Cloudflare Tunnel → Edit`, `Zone → DNS → Edit` y
`Zone → Zone → Read`. Antes de tocar nada, verificar que se está en la
zona correcta:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=formotos.com" | jq '.result[0].status'
```

Si devuelve `pending`, esa no es la zona que sirve el DNS.

Con Cloudflare Tunnel el TLS lo termina Cloudflare y el túnel entrega
tráfico plano a Traefik, así que **no** hay que activar Let's Encrypt en
los dominios de Coolify: el certificado nunca podría validarse, no hay un
`:80` alcanzable desde fuera.

## Rutina de despliegue

**A test:** merge a `develop` → _Deploy_ en Coolify → verificar migraciones.

**A producción:** siguiendo gitflow —

1. `release/vX.Y.Z` desde `develop`, PR a `main`, CI verde.
2. Merge del PR. **Ojo:** si la rama de release se actualiza después de
   abrir el PR, hay que asegurarse de que el merge incluya esos commits;
   ya pasó una vez que `main` quedó sin un fix por mergear el PR antes de
   tiempo.
3. _Deploy_ manual en el entorno production.
4. Retro-merge de la release a `develop` y tag `vX.Y.Z` sobre `main`.

Rollback: _Deployments_ → el despliegue anterior → _Redeploy_. Una
migración aplicada no se revierte sola al volver a la imagen anterior; si
el rollback la necesita, `npm run migrate:down` va antes.

## Verificación post-despliegue

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep <uuid-app>   # (healthy)
curl -s http://127.0.0.1:3000/healthz                            # {"status":"ok"}
curl -s https://<nodo>.ts.net/login -o /dev/null -w "%{http_code}\n"   # 200
```

Y el conteo de migraciones de la sección anterior.

## Gotchas conocidos

- **El healthcheck va a `127.0.0.1`, no a `localhost`.** Dentro del
  contenedor `localhost` resuelve primero a `::1` y la app solo escucha en
  IPv4: el healthcheck falla eternamente con `connection refused` y Coolify
  marca el recurso como degradado. El comando que genera usa `curl` y cae a
  `wget` —alpine no trae curl—, así que en los logs se ve
  `curl: not found` seguido del error real.
- **El proxy de Coolify puede quedarse colgado en "Starting"** sin que
  exista el contenedor. Su compose vive en `/data/coolify/proxy/`, que es
  de root, y **solo se escribe cuando el proxy arranca de verdad**: si el
  directorio está vacío, es que nunca llegó a arrancar. Se destraba con
  _Servers → localhost → Proxy → Actions → Restart Proxy_. Si falla por
  `port is already allocated`, hay otro servicio en ese puerto (aquí SigNoz
  ocupaba el 8080, y el dashboard de Traefik se movió al 8081 editando el
  compose desde el panel).
- **Una app que ya usa una source de GitHub App no puede volver a "Public
  GitHub"** desde la interfaz: el desplegable deja de ofrecerlo. Conviene
  no cambiar de source sin necesidad.
- **El registro automático de la GitHub App necesita que Coolify sea
  alcanzable** por la URL de callback (`http://<ip>:8000`). Sin exposición
  pública hay que usar la instalación manual y copiar App ID, Installation
  ID, Client ID, Client secret y la private key a mano.
- **La zona de Cloudflare tiene que estar `active`, y ser la correcta** —
  ver "Exposición pública".
- **`docker-compose` v1 está roto en esta máquina** — usar `docker compose`.
- **`docker-compose.yml` del repo es solo para desarrollo local.** Coolify
  no lo usa: cada entorno tiene sus recursos gestionados.
