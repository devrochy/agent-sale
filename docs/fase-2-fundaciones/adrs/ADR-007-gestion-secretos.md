# ADR-007: Gestión de secretos

## Estado
Aceptado.

## Contexto
La plataforma maneja credenciales sensibles: API key de Claude, credenciales del BSP (Twilio, ADR-001), cadena de conexión a Postgres (Supabase, ADR-006), y futuras claves de terceros. Necesitamos evitar que vivan como texto plano en el repositorio o en configuración no auditada, sin adoptar una herramienta de vault dedicada que no se justifica todavía al costo/tamaño de este proyecto.

## Decisión
Usar la gestión de secretos **nativa de cada plataforma ya elegida**, en vez de un vault de terceros dedicado:

- **CI/CD (GitHub Actions):** GitHub Encrypted Secrets, a nivel de repositorio/entorno (`staging` / `production` como entornos separados con sus propios secretos).
- **Runtime de la aplicación (Fly.io):** Fly Secrets (variables de entorno cifradas propias de Fly.io), inyectadas en el contenedor en el arranque.
- **Base de datos (Supabase):** credenciales gestionadas por el propio proveedor; la cadena de conexión se distribuye como secreto en Fly.io/GitHub, nunca en el repositorio.

Ningún secreto se versiona en el repositorio, ni siquiera en archivos `.env` de ejemplo con valores reales (solo `.env.example` con claves vacías).

## Por qué no un vault dedicado (todavía)
Herramientas como HashiCorp Vault o Doppler agregan una pieza de infraestructura adicional (y en muchos casos costo) que no se justifica con un solo tenant piloto y un equipo pequeño. Se documenta como **disparador de revisión**: si el número de tenants o de entornos crece lo suficiente para que rotar/auditar secretos manualmente sea riesgoso, evaluar un vault dedicado en la Fase 10 (Preparación para Escala).

## Consecuencias
- Cada entorno (staging/producción) tiene su propio set de secretos, nunca compartido.
- La rotación de credenciales (ej. si se filtra una API key) es un proceso manual mientras el proyecto es pequeño — aceptable a este tamaño, pero debe quedar documentado como deuda técnica a revisar cuando crezca el número de tenants.
