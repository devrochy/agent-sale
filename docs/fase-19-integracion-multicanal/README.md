# Fase 19 — Integración Multicanal (Instagram, Facebook/Meta)

Estado: **Etapas A, B y C1 completas** (v2) — gateway multicanal, panel de conexiones, WhatsApp por Meta Cloud API e identidad de cliente por canal. Faltan C2 (Instagram) y C3 (Messenger); ver "Estado de implementación" en [ADR-029](./adrs/ADR-029-arquitectura-gateway-multicanal.md).

Referencia: [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md#fase-19--integración-multicanal-instagram-facebookmeta) · [PROPUESTA_V2.md §3.11](../../PROPUESTA_V2.md) · [Fase 3 — Integración WhatsApp](../fase-3-whatsapp-gateway/README.md) · [plan-escalado-multi-cliente.md](../plan-escalado-multi-cliente.md)

Extiende el gateway de mensajería (hoy exclusivamente WhatsApp/Twilio) con un contrato de canal genérico que permita operar también sobre Instagram Direct y Facebook Messenger vía la API de Meta. Es, en palabras de la propia propuesta, "la pieza de mayor esfuerzo estructural" de todo v2.

## Relación con v1

- **Completamente nueva** — no hay equivalente en [Fase 3](../fase-3-whatsapp-gateway/README.md), que es monocanal por diseño (BSP de WhatsApp vía Twilio). No es una extensión del webhook existente: es un gateway adicional con su propio contrato de verificación de firma y ventana de mensajería.
- Se relaciona directamente con el hallazgo de [`plan-escalado-multi-cliente.md`](../plan-escalado-multi-cliente.md): *"Número de WhatsApp — envío: No parametrizable — todos los tenants envían desde la misma cuenta/número"*. Esta fase no resuelve ese punto (sigue siendo un pendiente de escalado multi-tenant, no de multicanal), pero cualquier diseño de gateway genérico debe evitar repetir el mismo acoplamiento para los canales nuevos: cada canal debe resolver sus credenciales por tenant desde el primer día, no como global.

## Contenido de esta fase

- [adrs/ADR-029-arquitectura-gateway-multicanal.md](./adrs/ADR-029-arquitectura-gateway-multicanal.md) — contrato de adapter genérico, dónde vive `conversations.channel`, y cómo se resuelve la ventana de mensajería de Meta Messenger frente a la de WhatsApp (ADR-019).
- [adrs/ADR-033-meta-cloud-api-segundo-proveedor-whatsapp.md](./adrs/ADR-033-meta-cloud-api-segundo-proveedor-whatsapp.md) — Etapa B: normalización de direcciones de Meta, un hilo por cliente, y estados de entrega por webhook.

## Dependencias

Ninguna estructural sobre las Fases 13-18 — puede ejecutarse en paralelo. `conversations.channel` puede introducirse ya en la Fase 18 (valor único `whatsapp`) para que esta fase solo la pueble, no la cree.

## Riesgos

- Subestimar el esfuerzo real arrastraría la fecha de todo lo demás si se le asignan las mismas 2-4 semanas típicas de otras fases de v2 — ver la estimación ampliada en `MASTER_PLAN_V2.md`.
- Verificación de negocio de Meta para permisos de Messenger/Instagram puede tardar semanas — mismo riesgo no controlable que ya vivió la Fase 3 con WhatsApp Business y la Fase 9 con la cuenta BSP real.
- Ningún código nuevo de esta fase debe asumir WhatsApp en un punto donde antes no se asumía — revisar contra el principio explícito de `plan-escalado-multi-cliente.md`: "¿esto asume algo específico o es genérico?".

## Definición de terminado

De la fase completa (las tres etapas):

- [ ] Un mensaje entrante por Instagram Direct genera una conversación con `channel = 'instagram'`, visible en el panel (Fase 18) con el mismo tratamiento que una de WhatsApp. — Etapa C2. El esquema ya lo soporta desde C1; falta el adapter.
- [x] El agente responde por el mismo canal **y la misma conexión** que recibió el mensaje. Implementado en la Etapa A: `sendToConversation` resuelve el adapter desde `conversations.connection_id`, y los 8 envíos al cliente lo usan. Queda ejercitado con un solo canal hasta que exista un segundo proveedor (Etapa B).
- [x] Verificación de firma de webhook implementada y probada para el adapter de Meta, mismo rigor que Twilio (Fase 3). Etapa B: HMAC-SHA256 sobre el cuerpo crudo con comparación de tiempo constante, más el handshake `GET`, con tests unitarios y de integración.

De la Etapa C1, cerrada (ver [ADR-037](./adrs/ADR-037-identidad-de-cliente-por-canal.md)):

- [x] La identidad del cliente es `(channel, external_id)`, no un teléfono — Instagram y Messenger ya tienen dónde guardarse.
- [x] Las conversaciones quedan separadas por canal y se responde siempre por donde el cliente escribió.
- [x] Cuando el teléfono coincide, los datos de gestión del pedido (nombre, cédula, dirección, ciudad) se reusan entre canales, sin mezclar conversaciones.
- [x] El panel de Clientes marca el canal de cada fila, y la búsqueda encuentra por canal y por teléfono de contacto.

De la Etapa B, cerrada:

- [x] WhatsApp opera por Meta Cloud API como segundo proveedor, en paralelo con Twilio.
- [x] Una conversación responde por la conexión por la que entró, y sigue al último número que usó el cliente.
- [x] El panel da de alta y edita conexiones de Meta, validando contra el proveedor antes de guardar.
- [x] La bandeja muestra el canal y el proveedor de origen de cada conversación.

De la Etapa A, cerrada:

- [x] Matriz canal × proveedor persistida (`channel_connections`), con las credenciales cifradas y configurables desde `/admin/conexiones` sin reiniciar el proceso.
- [x] Twilio migrado al contrato de adapters — el SDK ya no se importa fuera de `src/gateway/channels/twilio/`.
- [x] El webhook entrante rutea por conexión y verifica la firma con la credencial de esa conexión.
- [x] Primeros tests del envío saliente, que no tenía ninguno.

Puede ejecutarse en paralelo con las Fases 14-18 y 20.
