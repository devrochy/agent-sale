# gateway

Entrada y salida de mensajería, sobre una matriz **canal × proveedor** (Fase 19,
ver `docs/fase-19-integracion-multicanal/adrs/ADR-029-arquitectura-gateway-multicanal.md`).
No conoce dominios de negocio (ver `docs/fase-2-fundaciones/estructura-repositorio.md`).

El webhook entrante identifica a qué **conexión** pertenece el request, verifica
la firma con la credencial de esa conexión, normaliza y encola en Redis Streams
(`whatsapp:inbound`). Solo una firma inválida responde 403: una conexión
desconocida o inactiva responde 200 sin encolar, porque un no-2xx haría que el
proveedor reintente indefinidamente.

- `server.ts` / `index.ts` — Fastify, `POST /webhooks/whatsapp`, `POST /webhooks/wompi`, `GET /healthz`. Los webhooks viven en un plugin encapsulado con su propio parser, que conserva el cuerpo crudo sin reemplazar el de JSON del resto de la app.
- `webhookHandler.ts` — orquesta el flujo, agnóstico de proveedor (ver `docs/fase-3-whatsapp-gateway/webhook-contrato.md`).
- `channels/` — el contrato (`types.ts`), el registro por proveedor (`registry.ts`) y las implementaciones (`twilio/`). Agregar un proveedor es agregar una carpeta y una entrada en el registro.
- `sendMessage.ts` — fachada de salida. `sendToConversation` responde por la conexión por la que entró el cliente; `sendToPrimary` cubre lo que no tiene conversación (notificaciones a administradores). No habla con ningún SDK: delega en el adapter.
- `idempotency.ts`, `queue.ts`, `messageSplitter.ts` — piezas individuales del flujo.

Las credenciales no viven en variables de entorno: están cifradas en
`channel_connections` y se editan desde `/admin/conexiones` sin reiniciar el
proceso (ver `src/shared/db/connectionsDirectory.ts`).
