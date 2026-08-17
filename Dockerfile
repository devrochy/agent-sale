# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# `--include=dev` explícito: si el entorno del build trae NODE_ENV=production
# (Coolify inyecta las variables de la aplicación también en el build, salvo
# que se marquen "Not available during build"), npm se salta las
# devDependencies y `npm run build` muere con "tsc: not found". Esta etapa
# necesita el toolchain sí o sí: no puede depender de una variable de fuera.
RUN npm install --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
# `--omit=dev` deja fuera todo el toolchain de desarrollo, pero
# node-pg-migrate es dependencia de producción a propósito (ver
# docs/despliegue-coolify.md): el despliegue corre `npm run migrate` como
# comando pre-deployment *con esta misma imagen*, así que el binario
# tiene que existir en la imagen final, no solo en la de build.
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

EXPOSE 3000
# Las migraciones corren en el arranque del propio contenedor, no como
# comando de despliegue del orquestador. Coolify ejecuta su "pre-deployment"
# dentro del contenedor **anterior**, que tiene la imagen vieja: sus
# migrations/ no incluyen las de la versión que se está desplegando, así que
# reporta "No migrations to run!" y la app nueva arranca contra un esquema
# atrasado y muere. Pasó en los dos entornos.
#
# Acá el orden queda garantizado: si `migrate` falla, el proceso no llega a
# escuchar, el healthcheck no pasa y el orquestador revierte — que es
# justo lo que se quiere, en vez de servir tráfico con el esquema viejo.
CMD ["sh", "-c", "npm run migrate && node dist/src/index.js"]
