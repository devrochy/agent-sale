---
name: desplegar-test
description: Mergea un PR a develop y despliega el resultado en el entorno de test de Coolify, verificando que quedó sano (contenedor healthy, migraciones al día, login respondiendo). Úsala cuando el usuario quiera "desplegar a test", "subir esto a test", "validar en test" o mergear un PR y ver el resultado corriendo.
---

# Desplegar a test

Ciclo completo: PR → `develop` → despliegue en Coolify → verificación. Está
escrito a partir de los fallos reales de esta infraestructura, no de la
teoría: cada verificación existe porque algo se rompió en silencio antes.

## Datos del entorno

| Qué | Valor |
| --- | --- |
| Coolify | `http://172.18.0.1:8000` |
| Proyecto | `eusmavvfuseqbdxifuxxb8yi` (Formotos) |
| Entorno test | `qgqeqsuy4a9shlhkeofcdog6` |
| App test | `7vhtabw7ldyaplqzpofaqosd` (rama `develop`) |
| Postgres test | contenedor `pxm3ju8bet4rdmkxeifwpzlu` |
| URL pública | `https://devrochy.tail2ad60a.ts.net` |
| Puerto local | `127.0.0.1:3000` |

Producción es otra app (`gxkaifspgoupoopcjwsvhbff`, rama `main`, Postgres
`nnum0yrlo6ysu5dbayk5wfbi`, `127.0.0.1:3001`, Funnel en el `:8443`) y **no**
se toca desde acá: a producción se llega por una release, no por un merge a
`develop`.

## 1. Mergear el PR

Antes de mergear:

- Si el PR está apilado sobre otra rama de feature, **reapuntar los hijos a
  `develop` antes** de mergear el padre (`gh pr edit <n> --base develop`).
  GitHub cierra el hijo sin reapuntarlo, y el trabajo se pierde de vista.
- Comprobar que el CI está verde:
  `gh pr view <n> --json statusCheckRollup --jq '.statusCheckRollup[] | select(.name=="Lint, tests, build") | .conclusion'`
- Si el usuario tiene cambios sin commitear en la rama del PR, preguntarle
  qué hacer con ellos antes de mergear.

```bash
gh pr merge <n> --merge
```

> La API de GitHub cae de vez en cuando con `HTTP 503` en `pr create` y
> `pr merge`, mientras `git push` sigue funcionando. Si pasa, reintentar en
> bucle (cada 40-60 s) en vez de darlo por fallido.

## 2. Lanzar el despliegue

**El botón "Deploy" del menú Actions no responde a la automatización**: el
menú se cierra en cuanto llega otra llamada MCP y las referencias caducan.
Lo que sí funciona es dispararlo desde la propia página con
`javascript_tool`, estando en la vista de la aplicación o de sus deployments:

```js
const b = [...document.querySelectorAll('[wire\\:click="deploy"]')][0];
b.click();
```

## 3. Verificar que quedó sano

**Nunca dar por bueno el estado que muestra Coolify.** Se ha visto marcar
`Success` con la aplicación muerta y sin contenedor.

```bash
# 1. Contenedor arriba. Ojo: grep "healthy" también matchea "unhealthy".
docker ps --format '{{.Names}}\t{{.Status}}' | grep 7vhtabw | grep "(healthy)"

# 2. Migraciones al día: los dos números tienen que coincidir.
docker exec pxm3ju8bet4rdmkxeifwpzlu psql -U postgres -d agent_sale -tAc "SELECT count(*) FROM pgmigrations;"
git ls-tree --name-only origin/develop migrations/ | wc -l

# 3. La aplicación responde de verdad.
curl -s http://127.0.0.1:3000/healthz          # {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/login   # 200
```

Para esperar sin adivinar tiempos, usar un bucle sobre la condición real
(el contenedor nuevo tiene un nombre distinto al viejo):

```bash
OLD=$(docker ps --format '{{.Names}}' | grep 7vhtabw | head -1)
until docker ps --format '{{.Names}}\t{{.Status}}' | grep 7vhtabw | grep -v "$OLD" | grep -q "(healthy)"; do sleep 15; done
```

## Si algo falla

**El contenedor desaparece y el despliegue figura como Success.** Casi
siempre es el esquema: la app muere al arrancar porque le falta una
migración. Comprobar el conteo del paso 2. Desde la `v1.1.1` las migraciones
corren en el `CMD` del contenedor, así que esto no debería volver a pasar;
si pasa, migrar a mano con la imagen ya construida y redesplegar:

```bash
IMG=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep 7vhtabw | head -1)
docker run --rm --network coolify --env-file ~/agent-sale-deploy/test.env "$IMG" npm run migrate
```

**El contenedor queda `unhealthy` con `connection refused`.** El healthcheck
tiene que apuntar a `127.0.0.1`, no a `localhost`: dentro del contenedor
`localhost` resuelve primero a `::1` y la app solo escucha en IPv4. Se
verifica en la base de Coolify:

```bash
docker exec coolify-db psql -U coolify -d coolify -tAc "SELECT uuid, health_check_host FROM applications;"
```

**El build muere con `tsc: not found`.** `NODE_ENV=production` llegó al
build y npm se saltó las devDependencies. La variable va marcada "Not
available during build" en el panel.

**Cambios que no se guardan en el panel.** Los formularios de Coolify a
veces aceptan el valor y no lo persisten. Después de cambiar algo
importante, verificarlo contra `coolify-db` en vez de fiarse de la interfaz.

## Al terminar

Reportar al usuario, con datos y no con adjetivos: qué commit quedó
desplegado, el conteo de migraciones, y el resultado de `/healthz` y
`/login`. Si algo quedó a medias, decirlo explícitamente.
