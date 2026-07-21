# ADR-001: Proveedor BSP para la API de WhatsApp

## Estado
Aceptado (con verificación final de cotización oficial pendiente antes de crear la cuenta en la Fase 3).

## Contexto
La plataforma necesita conectarse a la API oficial de WhatsApp Business de Meta. Construir esa integración desde cero (verificación de negocio, gestión de plantillas, manejo de rate limits, ventana de 24h) es una de las causas más comunes de retraso en proyectos de este tipo. La práctica estándar de la industria (Yalo, Gupshup, Blip, Aivo) es apoyarse en un BSP (Business Solution Provider) certificado por Meta.

## Dato clave que cambió el análisis
Meta rediseñó su modelo de precios el 1 de julio de 2025: pasó de cobrar por "conversación" (ventana de 24h) a cobrar **por mensaje de plantilla enviado**, categorizado en marketing / utility / authentication / service. Los **mensajes de servicio** (el agente respondiendo dentro de una conversación que el cliente inició) **son gratuitos**. Colombia tiene además algunas de las tarifas más bajas del mundo para utility/authentication (~$0.0008 USD/mensaje) y marketing (~$0.014 USD/mensaje).

Para el caso de ForMotos (~100 conversaciones/semana ≈ 430/mes, casi todas iniciadas por el cliente), el costo de Meta en sí mismo es marginal. **El costo real queda dominado por la tarifa del BSP, no por Meta.**

## Opciones consideradas y costo estimado a este volumen

| BSP | Modelo de cobro | Estimado mensual (~430 conversaciones) | Ventajas | Riesgos |
|---|---|---|---|---|
| **Twilio** | Sin tarifa fija, ~$0.005 USD por mensaje (plataforma) + Meta | ~$2–5 USD/mes a este volumen | El más barato en volumen bajo; DX y documentación muy maduros | El costo crece linealmente con el volumen — deja de ser el más barato si ForMotos escala fuerte o se suman más tenants con alto tráfico |
| **360dialog** | Tarifa fija €49–249/mes, sin markup por mensaje de Meta | ~€49 (~$53 USD) fijo | Predecible; se vuelve más barato que Twilio cuando el volumen crece, porque no cobra por mensaje | A este volumen bajo, la tarifa fija es más cara que el modelo de Twilio — se está pagando por capacidad que no se usa todavía |
| **Gupshup** | Plan mínimo ~₹4.000+/mes (~$48 USD) + $0.001/mensaje | ~$48+ USD | Pensado para escala grande (100k+ mensajes/mes), útil si se planea multi-tenant agresivo | Sobredimensionado y más caro que las otras dos opciones para un solo piloto de bajo volumen |

## Decisión
**Empezar con Twilio para el piloto de ForMotos**, por ser la opción de menor costo real al volumen actual (~430 conversaciones/mes) al no tener tarifa fija. Se documenta como decisión reversible: si el volumen crece de forma sostenida (ForMotos escala, o se incorporan más tenants con tráfico alto), **reevaluar la migración a 360dialog**, cuyo modelo de tarifa fija se vuelve más económico a partir de cierto volumen de mensajes.

El punto de cruce aproximado (dónde 360dialog empieza a ser más barato que Twilio) ocurre cuando el costo variable de Twilio (mensajes × $0.005) supera la tarifa fija de 360dialog (~$53/mes) — es decir, alrededor de ~10.000 mensajes/mes. Por debajo de ese umbral, Twilio gana; por encima, 360dialog gana. Este umbral debe recalcularse con cifras oficiales, no solo estimaciones de mercado.

## Importante — esto NO es una cotización oficial
Las cifras de esta tabla vienen de fuentes públicas de mercado (blogs especializados y documentación de precios de cada proveedor), no de una cotización directa. **Antes de crear la cuenta real en la Fase 3**, se debe:
1. Contactar a Twilio (y opcionalmente 360dialog como respaldo) para confirmar tarifas exactas aplicables a Colombia.
2. Confirmar si existen costos ocultos: verificación de negocio, número de WhatsApp dedicado, soporte, mínimos de facturación.
3. Validar que el proceso de verificación de negocio ante Meta no tenga fricción particular para una PyME colombiana.

## Consecuencias
- La plataforma solo necesita implementar: webhook receiver + cliente HTTP hacia el BSP elegido — no lógica de conexión directa con Meta.
- Cambiar de BSP en el futuro (de Twilio a 360dialog si el volumen lo justifica) implica reemplazar una integración acotada (webhook + cliente API), no rediseñar el sistema, siempre que el contrato interno (`Webhook Receiver` → `Cola`) se mantenga estable — este ADR es explícitamente una decisión revisable, no definitiva.
- El umbral de ~10.000 mensajes/mes queda como disparador documentado para reabrir esta decisión (ver Fase 10 — Preparación para Escala).

## Fuentes consultadas (julio 2026)
- [360dialog Pricing](https://360dialog.com/pricing)
- [Gupshup Historical Meta Pricing](https://www.gupshup.ai/resources/historical-meta-pricing/)
- [Twilio WhatsApp Pricing Breakdown — Zernio](https://zernio.com/blog/twilio-whatsapp-pricing-breakdown-what-it-really-costs)
- [Meta WhatsApp Business Platform Pricing — FormBeep](https://formbeep.com/whatsapp-api-pricing/)
