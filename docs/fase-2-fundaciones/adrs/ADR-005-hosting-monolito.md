# ADR-005: Plataforma de hosting para el monolito modular

## Estado
Aceptado (con confirmación de costo real pendiente antes de desplegar en la Fase 2 de implementación).

## Contexto
El sistema se despliega como un monolito modular contenedorizado (ver `arquitectura.md` de la Fase 1). Se necesita una plataforma de hosting que: soporte Docker, tenga CI/CD simple desde GitHub, y sea barata al volumen bajo del piloto de ForMotos (~430 conversaciones/mes) sin imponer una arquitectura de microservicios que no necesitamos.

## Opciones consideradas (datos de mercado, julio 2026)

| Plataforma | Modelo de cobro | Costo estimado a bajo tráfico | Riesgo clave |
|---|---|---|---|
| **Render** | Tarifa fija por servicio (~$7/mes web + ~$7/mes Postgres) | ~$21-28/mes en plan Hobby | Tiene *free tier* real, pero los servicios gratuitos entran en reposo tras 15 min de inactividad y tardan ~1 min en "despertar" — **inaceptable** frente a nuestro objetivo de <30s de tiempo de respuesta (Fase 0) |
| **Railway** | Sin free tier, cobro por segundo + plan base | ~$10-15/mes para un setup típico pequeño | Más barato que Render, pero sin capa gratuita — cualquier tráfico genera costo desde el primer minuto |
| **Fly.io** | Puro pay-as-you-go por segundo, sin tarifa base | Estimado más bajo de los tres a tráfico bajo/esporádico | Requiere algo más de configuración (Dockerfile/`fly.toml`) que Railway/Render; puede mantenerse siempre activo a bajo costo evitando cold-starts |

## Decisión
**Fly.io.** Su modelo pay-per-second sin tarifa base es el más barato al volumen actual, y permite configurar al menos una instancia siempre activa a costo bajo — evitando el cold-start de Render, que rompe directamente nuestro objetivo de tiempo de respuesta definido en la Fase 0. Railway queda como alternativa de respaldo si la configuración de Fly.io resulta más compleja de lo esperado al implementar.

## Consecuencias
- El Dockerfile del monolito debe diseñarse pensando en despliegue en Fly.io (imagen ligera, arranque rápido) desde la Fase 2 de implementación.
- Al ser pay-as-you-go, el costo crece con el tráfico real — se debe monitorear (Fase 8, Observabilidad) para no tener sorpresas si el uso crece rápido.
- Decisión revisable si en la práctica Fly.io no ofrece la simplicidad operativa esperada; Railway es el reemplazo natural.
