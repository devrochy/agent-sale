# `handoff_queue` y Notificación al Asesor

Implementa la tabla `handoff_queue` y `human_agents` ya definidas en [modelo-datos.md](../fase-1-arquitectura/modelo-datos.md) (Fase 1), con el mecanismo real de notificación para el caso de ForMotos.

## Qué se escribe en `handoff_queue`

Cuando `escalar_a_humano` se ejecuta (ver [reglas-escalamiento.md](./reglas-escalamiento.md)):

```json
{
  "tenant_id": "<uuid de ForMotos>",
  "conversation_id": "<uuid>",
  "reason": "monto_alto | queja | intentos_fallidos | solicitud_cliente | compatibilidad_tecnica",
  "status": "pendiente",
  "assigned_to": null,
  "created_at": "<timestamp>"
}
```

El registro queda `pendiente` (sin asignar) hasta que un asesor lo toma — para ForMotos, con un equipo pequeño, no se diseña un algoritmo de asignación automática por carga; el primer asesor disponible que revise la bandeja toma el caso.

## Mecanismo de notificación: reutilizar WhatsApp

ForMotos es un negocio pequeño — no se justifica introducir una herramienta de soporte dedicada (Zendesk, Intercom, etc.) solo para notificar escalamientos, according con el requisito de bajo costo del proyecto. Se reutiliza la infraestructura que ya existe:

**El sistema envía un mensaje de WhatsApp** (vía Twilio, ya integrado desde la Fase 3) al número de contacto del asesor humano (`human_agents.contact`), con el resumen de la conversación y un enlace a la [vista mínima](./vista-asesor.md).

```
🔔 Conversación escalada — ForMotos
Motivo: monto_alto
Cliente: +57...
Resumen: Cliente cotizó 3 cascos + 2 llantas ($950.000), pidió hablar con alguien antes de confirmar.
Ver conversación: <enlace a vista-asesor>
```

Esto no agrega ningún costo de infraestructura nuevo (mismo BSP, mismo número de WhatsApp de negocio o uno secundario) y llega al lugar donde el equipo de ForMotos ya está mirando — su propio WhatsApp, consistente con cómo operan hoy (Fase 0: 100% manual por WhatsApp).

## Reasignación y cierre

- Cuando un asesor toma el caso (acción manual desde la [vista mínima](./vista-asesor.md)), `handoff_queue.status` pasa a `"en_atencion"` y `assigned_to` se llena.
- Cuando el asesor termina de atender al cliente por su cuenta (fuera del agente), marca el caso como `"resuelto"` y `resolved_at` se completa.
- **La conversación no vuelve automáticamente al agente** después de resolverse — si el cliente escribe de nuevo más adelante, es una conversación nueva que el agente evalúa desde cero (no hay retorno automático a modo IA a mitad de una atención humana, para evitar que el agente interrumpa a un asesor que sigue conversando manualmente con el cliente por fuera del sistema).

## Qué no cubre este documento
- Implementación real del envío de notificación (código) — fuera del alcance de este plan de arquitectura.
- Algoritmo de asignación automática por carga — no se diseña para el volumen y tamaño de equipo actual de ForMotos; se revisita si el número de asesores/volumen crece (Fase 10).
