# Checklist: cuenta de Twilio + verificación de negocio ante Meta

**Esto es una lista de acciones manuales que el dueño/responsable de ForMotos (o quien administre la cuenta) debe ejecutar fuera de este repositorio.** No es algo que se resuelva con documentación de arquitectura ni con código — requiere una cuenta real, documentos legales del negocio, y un número de teléfono dedicado.

## 1. Cuenta de Twilio
- [ ] Crear cuenta en [twilio.com](https://www.twilio.com) con el correo/organización de ForMotos (no una cuenta personal).
- [ ] Configurar método de pago (aunque el costo estimado sea bajo, ver [ADR-001](../fase-1-arquitectura/adrs/ADR-001-bsp-whatsapp.md), Twilio requiere tarjeta o saldo prepago).
- [ ] Solicitar acceso al **WhatsApp Business API** dentro de Twilio (no es automático — Twilio guía un flujo de onboarding específico para WhatsApp).

## 2. Meta Business Manager
- [ ] Crear (o usar uno existente) un **Meta Business Manager** para ForMotos.
- [ ] Verificar el negocio ante Meta: requiere documento legal que confirme la existencia de ForMotos (registro mercantil / Cámara de Comercio, NIT), y puede requerir verificación de dirección o dominio (`formotos.com`).
- [ ] Vincular el Business Manager con el proyecto de Twilio, siguiendo el flujo de "Embedded Signup" de Twilio (Twilio actúa como intermediario técnico, pero Meta es quien aprueba la verificación).

## 3. Número de WhatsApp Business
- [ ] Definir qué número usará ForMotos: ¿el mismo que usan hoy para el WhatsApp manual, o uno nuevo? — **si se reutiliza el número actual, hay que migrarlo formalmente a WhatsApp Business API (proceso de Meta, es irreversible sin soporte)**. Esta decisión debe tomarse con el dueño del negocio, no unilateralmente.
- [ ] Configurar el **nombre para mostrar** ("Display Name") que verán los clientes — sujeto a aprobación de Meta (debe coincidir razonablemente con el nombre del negocio).
- [ ] Definir el perfil de negocio (foto, descripción, categoría, horario) que se muestra en el chat de WhatsApp.

## 4. Configuración del Webhook
- [ ] Una vez exista una URL pública de staging (Fase 2 — Fly.io), registrar esa URL como webhook de mensajes entrantes en la consola de Twilio.
- [ ] Guardar el **Auth Token** de Twilio como secreto (ver [ADR-007](../fase-2-fundaciones/adrs/ADR-007-gestion-secretos.md)) — es la clave usada para verificar la firma de cada webhook (ver [webhook-contrato.md](./webhook-contrato.md)).

## 5. Plantillas de mensajes
- [ ] Enviar a aprobación de Meta las plantillas definidas en [plantillas-mensajes.md](./plantillas-mensajes.md) — la aprobación puede tardar de horas a pocos días y puede ser rechazada si el texto no cumple las políticas de Meta (ej. lenguaje demasiado promocional en plantillas de utilidad).

## Tiempos a considerar
La verificación de negocio y la aprobación de plantillas **no están bajo nuestro control** — son procesos de Meta que pueden tardar días. Esto ya está reflejado como riesgo en la estimación de la Fase 3 del [MASTER_PLAN.md](../../MASTER_PLAN.md#fase-3--integración-con-whatsapp-bsp-y-gateway-de-mensajería) ("2-3 semanas, incluye tiempo de espera de aprobación de Meta"). Recomendación: iniciar este checklist en paralelo a la implementación técnica, no después.
