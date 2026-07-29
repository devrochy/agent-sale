# ADR-018: Infraestructura de jobs programados

## Estado
Aceptado.

## Contexto
Varias de las capacidades analizadas en [analisis-superpoderes.md](../analisis-superpoderes.md) (Reporte diario, Cazador de ventas, Reactivación de leads fríos) requieren que el sistema actúe **sin que llegue un mensaje entrante primero** — ej. "cada mañana enviar un resumen" o "cada N horas revisar cotizaciones sin confirmar". Hoy no existe ningún mecanismo de este tipo: `package.json` no tiene `node-cron`, `bullmq`, `agenda`, ni ningún `setInterval` de negocio en `src/`. El único mecanismo periódico-adyacente es Redis Streams como cola de mensajes **entrantes** (`src/gateway/queue.ts`), que no aplica aquí — no hay ningún evento entrante que dispare estos jobs.

## Opciones consideradas

1. **`node-cron` (u otro scheduler) corriendo dentro del mismo proceso Fastify.** Cero infraestructura nueva — el mismo proceso que ya atiende el webhook registra tareas programadas al arrancar.
2. **Servicio/proceso separado dedicado a jobs**, desplegado aparte en Fly.io. Aísla el trabajo de background del path de request, pero duplica el despliegue (dos Dockerfiles/procesos, dos superficies de monitoreo) para un volumen de jobs que hoy es mínimo (un resumen diario, una revisión cada N horas).
3. **Cron externo (ej. GitHub Actions programado, o el scheduler de Fly.io) que golpea un endpoint HTTP interno.** Evita tener el scheduler en el proceso, pero agrega una superficie nueva de autenticación (ese endpoint necesita protegerse) y una dependencia de un sistema externo para algo que el propio proceso puede hacer solo.

## Decisión
**Opción 1: `node-cron` en el mismo proceso Fastify.**

Razones, con el mismo criterio de minimalismo de otras ADRs del proyecto:
- [ADR-005](../../fase-2-fundaciones/adrs/ADR-005-hosting-monolito.md) ya fijó que el despliegue en Fly.io mantiene **al menos una instancia siempre activa** (para evitar cold-starts) — no hay múltiples instancias compitiendo por ejecutar el mismo job, así que no se necesita coordinación distribuida (lock, leader election) para evitar que un job corra dos veces. Si en el futuro el proyecto escala a múltiples instancias (Fase 10), esta decisión se revisita.
- El volumen de jobs es bajo (unos pocos jobs, frecuencia de horas/días, no de segundos) — no justifica una cola de jobs dedicada (BullMQ) ni un proceso separado.
- No agrega ninguna superficie de red nueva que proteger (a diferencia de la opción 3).

## Consecuencias
- Nueva dependencia en `package.json`: `node-cron` (o equivalente ligero).
- Los jobs se registran en el arranque del servidor (`src/gateway/server.ts` o un módulo nuevo `src/jobs/`), con manejo explícito de errores por job (un job que falla no debe tumbar el proceso ni afectar el webhook).
- Si el proyecto migra a múltiples instancias antes de tener un scheduler distribuido real, hay que agregar un lock (ej. advisory lock de Postgres) para evitar que el mismo job corra en cada instancia — se documenta como disparador de revisión, no se resuelve preventivamente.
- Cada job nuevo (Reporte diario, Cazador de ventas, Reactivación de leads fríos) se especifica en su propia sección de [analisis-superpoderes.md](../analisis-superpoderes.md), esta ADR solo fija el mecanismo común.
