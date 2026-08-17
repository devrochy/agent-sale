# Vista Mínima del Asesor

Define qué necesita ver un asesor humano de ForMotos al abrir una conversación escalada, para poder continuar la atención sin pedirle al cliente que repita lo que ya dijo.

## Principio de diseño
Vista mínima **web**, no una nueva app — un enlace que el asesor abre desde el mensaje de WhatsApp de notificación (ver [handoff-queue.md](./handoff-queue.md)). Dado el tamaño del equipo de ForMotos y el requisito de bajo costo, no se justifica construir una aplicación de soporte completa para el MVP — una página de solo lectura con la información necesaria es suficiente.

## Contenido de la vista

1. **Datos del cliente** — número de WhatsApp, nombre de perfil (`customers.name`, `ProfileName` capturado en el webhook de Fase 3).
2. **Motivo del escalamiento** (`handoff_queue.reason`) y el resumen generado al momento de escalar.
3. **Historial completo de la conversación** — todos los mensajes (`messages`), en orden, incluyendo qué tools se ejecutaron en cada turno (ej. "el agente cotizó 3 cascos + 2 llantas por $950.000"), no solo el texto — así el asesor entiende qué datos concretos ya maneja el cliente, no solo lo que escribió.
4. **Estado estructurado** (`conversations.state`, ver [memoria-conversacional.md](../fase-4-motor-agente/memoria-conversacional.md), Fase 4) — en qué paso del flujo comercial estaba (cotizando, esperando confirmación de pedido, etc.), y el `quote_id` activo si existe, para que el asesor pueda abrir esa cotización real en el sistema en vez de rehacerla a mano.
5. **Botón de acción**: "Tomar conversación" — marca `handoff_queue.status = "en_atencion"` y `assigned_to` (ver [handoff-queue.md](./handoff-queue.md)).

## Cómo continúa la conversación

El asesor **responde directamente por WhatsApp** (desde su propio número o desde la interfaz de Twilio/el número de negocio, según se defina en implementación) — la vista es solo de lectura y contexto, no reemplaza al canal donde ya está la conversación con el cliente. No se construye un chat embebido dentro de la vista para el MVP; sería una funcionalidad adicional no solicitada frente a lo que el caso de uso realmente necesita.

## Autenticación de la vista
Acceso simple por enlace único (token en la URL, similar a un enlace de recuperación de contraseña), pensado para un equipo pequeño y confiable — no se diseña un sistema de login completo para el MVP. Se documenta como decisión a revisar si el número de asesores o tenants crece lo suficiente para que el riesgo de un enlace filtrado sea significativo (Fase 10).

## Qué no cubre este documento
- Implementación real de la vista (código, framework) — fuera del alcance de este plan de arquitectura.
- Integración con un chat embebido — deliberadamente fuera de alcance del MVP, ver arriba.
