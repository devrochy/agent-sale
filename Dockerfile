# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
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
CMD ["node", "dist/src/index.js"]
