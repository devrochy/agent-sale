# ADR-028: Convivencia del flujo de token de asesor (Fase 7) con la acción desde el panel

## Estado
Propuesta (pendiente de aceptación antes de iniciar implementación de la Fase 18).

## Contexto

[`vista-asesor.md`](../../fase-7-escalamiento-humano/vista-asesor.md) diseñó el acceso a un ticket escalado por **enlace único con token en la URL**, explícitamente para "un equipo pequeño y confiable", sin sesión de login — y documentó su propia condición de revisión: *"se documenta como decisión a revisar si el número de asesores o tenants crece lo suficiente para que el riesgo de un enlace filtrado sea significativo (Fase 10)"*. La Fase 13 de v2 ya introdujo login real con sesiones — esa condición está más cerca de cumplirse que cuando se escribió Fase 7, pero el disparador original hablaba de "número de asesores/tenants", no de "existe un panel con más funciones", así que no se da por automáticamente superada sin decidirlo.

`PROPUESTA_V2.md` §3.5 pide mover la *acción* (tomar/resolver) al panel, y plantea la pregunta explícitamente: "¿el flujo de token por WhatsApp se reemplaza o convive con la acción desde el panel?".

## Opciones consideradas

1. **Reemplazar completamente**: retirar `GET /asesor/:token` y `POST /asesor/:token/tomar|resolver`, todo asesor opera desde el panel autenticado (Fase 13). Requiere que todo asesor tenga cuenta de colaborador — coherente si el equipo de ForMotos ya cabe en el modelo de administradores de Fase 13, pero rompe el flujo para cualquier asesor que reciba el enlace de WhatsApp sin tener cuenta creada.
2. **Convivencia**: el enlace de WhatsApp (`vista-asesor.md`) se mantiene como notificación y vista de contexto, pero la *acción* de tomar/resolver ocurre preferentemente desde el panel; el endpoint de token sigue aceptando la acción como vía alterna (ej. un asesor que solo tiene el enlace y aún no tiene cuenta).
3. **Retirar solo la acción, mantener la vista de solo lectura por token**: el enlace de WhatsApp sigue mostrando el contexto completo (igual que hoy), pero `POST /asesor/:token/tomar|resolver` se elimina — toda acción pasa exclusivamente por el panel autenticado.

## Decisión

**Opción 3: el enlace de token pasa a ser de solo lectura; toda acción de tomar/resolver se centraliza en el panel.**

Razones:
- Con Fase 13 ya resuelta, cualquier persona que deba *actuar* sobre un ticket (tomarlo, cerrarlo) ya necesita ser un administrador/colaborador con cuenta — no tiene sentido mantener dos caminos de escritura (token y sesión) sobre el mismo estado (`handoff_queue.status`/`assigned_to`), que es exactamente la fuente de la condición de carrera que la Opción 2 dejaría sin resolver de raíz.
- El enlace de WhatsApp sigue siendo valioso como **notificación con contexto inmediato** — un asesor sigue recibiendo el mensaje de WhatsApp con el resumen y un enlace (`handoff-queue.md`, mecanismo de notificación ya construido, sin cambios), pero ese enlace ahora lleva a una vista de solo lectura que enlaza al ticket en el panel para actuar, en vez de exponer los dos botones de acción directamente sobre el token.
- Evita retirar por completo un mecanismo ya probado en producción (la notificación por WhatsApp) mientras sí resuelve el problema real que motivó el bloque 3.5: la acción vive en un solo lugar.

## Consecuencias

- `handoff-queue.md` (Fase 7) no queda descartado: el mecanismo de notificación por WhatsApp se mantiene sin cambios, solo cambia qué hace el enlace al abrirse.
- `POST /asesor/:token/tomar|resolver` se retira; cualquier enlace de token generado antes de este cambio sigue funcionando para *ver* el ticket, pero cualquier intento de acción vía ese endpoint responde redirigiendo al login del panel (no un error crudo).
- `handoff_tokens` (`migrations/0015`) se conserva — sigue siendo el mecanismo de autenticación de la vista de solo lectura, no se elimina la tabla.
- Si en el futuro se necesita que alguien sin cuenta de administrador pueda actuar sobre un ticket (ej. un asesor externo puntual), es una extensión posterior explícita, no algo que esta ADR deje abierto por accidente.
