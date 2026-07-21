# Fase 3 — Integración con WhatsApp (BSP) y Gateway de Mensajería

Estado: **completada** (rama `feature/fase-3-whatsapp-gateway`)

Referencia: [MASTER_PLAN.md](../../MASTER_PLAN.md#fase-3--integración-con-whatsapp-bsp-y-gateway-de-mensajería) · [Fase 2 — Fundaciones](../fase-2-fundaciones/README.md)

Igual que las fases anteriores, esta es documentación de diseño, no implementación. La diferencia con esta fase: incluye un entregable que **no es documentación ni código** — la verificación real del negocio ante Meta es una acción manual que solo el dueño/responsable de ForMotos puede ejecutar (ver [checklist-cuenta-bsp.md](./checklist-cuenta-bsp.md)).

## Contenido de esta fase

- [checklist-cuenta-bsp.md](./checklist-cuenta-bsp.md) — pasos manuales para crear la cuenta de Twilio y verificar el negocio ante Meta (acción del usuario, no de este repositorio).
- [webhook-contrato.md](./webhook-contrato.md) — contrato del endpoint receptor, con la corrección de que la firma real es `X-Twilio-Signature` (Twilio), no `X-Hub-Signature-256` (Meta directo) como decía el MASTER_PLAN original.
- [idempotencia.md](./idempotencia.md) — deduplicación por `MessageSid` de Twilio vía Redis, más la segunda capa ya definida en la tool `crear_pedido` (Fase 1).
- [cola-mensajes.md](./cola-mensajes.md) — esquema del stream, consumer group, y política de dead-letter tras 3 reintentos.
- [plantillas-mensajes.md](./plantillas-mensajes.md) — plantillas necesarias para ForMotos (confirmación de pedido, envío, promoción de temporada) y su proceso de aprobación.

## Definición de terminado

- [x] Contrato del webhook receiver definido, con verificación de firma correctamente especificada para el BSP elegido (Twilio).
- [x] Estrategia de idempotencia de eventos documentada (dos capas: transporte y negocio).
- [x] Diseño de la cola de mensajes entrantes/salientes, incluyendo manejo de fallos (dead-letter).
- [x] Plantillas de mensajes fuera de la ventana de 24h identificadas y su contenido definido.
- [ ] Cuenta de BSP configurada y verificada ante Meta — **acción manual pendiente del usuario**, no bloquea el resto de la documentación de arquitectura, pero sí bloquea cualquier prueba end-to-end real con WhatsApp.

**Fase 3 completada en su parte de diseño.** El "mensaje de prueba enviado y recibido end-to-end" que pide la Definición de Terminado del `MASTER_PLAN.md` solo puede ocurrir después de que se complete el checklist de cuenta BSP — queda marcado como el siguiente paso fuera de este repositorio, en paralelo a que avancemos con la Fase 4.
