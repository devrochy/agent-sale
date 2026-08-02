# ADR-029: Arquitectura de gateway multicanal (contrato genérico de adapter)

## Estado
Propuesta (pendiente de aceptación antes de iniciar implementación de la Fase 19).

## Contexto

`src/gateway/` hoy es Twilio-específico: recepción de webhook, verificación de firma (`X-Hub-Signature-256`), envío saliente (`sendMessage.ts`) y la ventana de 24h de WhatsApp (ADR-019) están escritos asumiendo un único canal. `PROPUESTA_V2.md` §3.11 pide operar también sobre Instagram Direct y Facebook Messenger, con el canal de origen visible en conversaciones/tickets (Fase 18).

## Opciones consideradas

1. **Duplicar el gateway completo por canal** (un `instagramGateway.ts`/`messengerGateway.ts` independiente, sin contrato compartido) — descartada: cada canal nuevo repetiría la lógica de idempotencia, cola de mensajes y resolución de tenant que ya existe para WhatsApp, con alto riesgo de que diverjan con el tiempo (ej. un fix de idempotencia en un canal y no en otro).
2. **Contrato de adapter genérico**, con WhatsApp como primera implementación migrada al mismo contrato — elegida.

## Decisión

### Contrato `ChannelAdapter`

```ts
interface InboundChannelAdapter {
  channel: "whatsapp" | "instagram" | "messenger";
  verifySignature(request): boolean;
  parseInboundMessage(payload): { tenantId, customerExternalId, content, mediaUrl? };
}

interface OutboundChannelAdapter {
  channel: "whatsapp" | "instagram" | "messenger";
  sendMessage(tenantId, customerExternalId, text): Promise<void>;
  isWithinMessagingWindow(conversation): boolean; // ver ADR-019 para WhatsApp
}
```

`src/orchestrator/consumer.ts` y `loop.ts` dejan de invocar `sendMessage.ts` (Twilio-específico) directamente — resuelven el adapter de salida a partir de `conversations.channel`. La cola de mensajes entrantes/salientes (Redis Streams, Fase 3) no cambia de forma, solo el paso final de I/O externo se vuelve polimórfico.

### `conversations.channel`

Columna nueva, `text CHECK (channel IN ('whatsapp', 'instagram', 'messenger'))`, default `'whatsapp'` — no requiere backfill de conversaciones históricas (todas las existentes son de WhatsApp por definición, el default ya es correcto sin tocar filas).

### Ventana de mensajería por canal

ADR-019 documentó la ventana de 24h específica de WhatsApp. Messenger/Instagram tienen su propia política (ventana estándar de 24h de Meta, con "etiquetas" para casos excepcionales — a confirmar contra la documentación vigente de Meta al iniciar implementación, puede haber cambiado). `isWithinMessagingWindow` se resuelve por adapter, no con una constante global — un canal no hereda por accidente la regla de otro.

### Credenciales por tenant desde el día uno

A diferencia de `sendMessage.ts:29` (WhatsApp, acoplado hoy a `env.twilioWhatsappNumber` global, ver hallazgo de `plan-escalado-multi-cliente.md`), los adapters de Instagram/Messenger resuelven sus credenciales desde `tenants` (BYOK cifrado, mismo patrón `secretBox.ts` que ya usan Wompi/LLM) desde el primer incremento — no se repite el acoplamiento global que hoy tiene WhatsApp, para no heredar la misma deuda en un canal nuevo.

## Consecuencias

- Migrar WhatsApp al nuevo contrato `ChannelAdapter` es parte del alcance de esta fase (no se deja como "adapter viejo + adapters nuevos incompatibles") — es el costo de introducir el contrato correctamente desde el principio.
- El acoplamiento ya documentado de WhatsApp a una única cuenta Twilio global (`plan-escalado-multi-cliente.md`) **no se resuelve en esta ADR** — sigue siendo un pendiente de escalado multi-tenant, fuera del alcance de multicanal. Se documenta para no confundir "cada canal resuelve sus propias credenciales por tenant" (lo que sí hace esta fase para los canales nuevos) con "WhatsApp ya es multi-tenant en el envío" (lo que no hace).
- El panel (Fase 18) puede mostrar el canal de origen de cualquier conversación leyendo directamente `conversations.channel`, sin lógica adicional.
