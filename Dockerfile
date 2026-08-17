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
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

EXPOSE 3000
CMD ["node", "dist/src/index.js"]
