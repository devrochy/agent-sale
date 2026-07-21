# gateway

Webhook receiver de Twilio (WhatsApp): verifica `X-Twilio-Signature`, aplica idempotencia por `MessageSid`, resuelve `tenant_id` por el número `To` y encola en Redis Streams (`whatsapp:inbound`). No conoce dominios de negocio (ver `docs/fase-2-fundaciones/estructura-repositorio.md`).

- `server.ts` / `index.ts` — Fastify, `POST /webhooks/whatsapp` + `GET /healthz`.
- `webhookHandler.ts` — orquesta el flujo (ver `docs/fase-3-whatsapp-gateway/webhook-contrato.md`).
- `twilioSignature.ts`, `idempotency.ts`, `queue.ts` — piezas individuales del flujo.

Envío saliente (respuestas del agente) todavía no está implementado — llega con el `orchestrator` (Fase 4), que es quien lo dispara.
