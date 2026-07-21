# ADR-001: Proveedor BSP para la API de WhatsApp

## Estado
Propuesto — pendiente de confirmar con cotización real antes de la Fase 3.

## Contexto
La plataforma necesita conectarse a la API oficial de WhatsApp Business de Meta. Construir esa integración desde cero (verificación de negocio, gestión de plantillas, manejo de rate limits, ventana de 24h) es una de las causas más comunes de retraso en proyectos de este tipo. La práctica estándar de la industria (Yalo, Gupshup, Blip, Aivo — ver investigación de mercado) es apoyarse en un BSP (Business Solution Provider) certificado por Meta.

## Opciones consideradas

| Opción | Ventajas | Riesgos/costos |
|---|---|---|
| **Gupshup** | Infraestructura probada a gran escala (120B+ mensajes/año), buen soporte de comercio conversacional | Precio orientado a empresas grandes; puede ser más caro que lo que un piloto de una PyME necesita |
| **360dialog** | Modelo self-serve, históricamente orientado a costo bajo, buena adopción en LatAm/Europa para PyMEs | Menos capacidades "todo en uno" que Gupshup — se complementa mejor con el propio orquestador (que ya estamos construyendo) |
| **Twilio** | Documentación y DX muy maduros, amplia adopción global | Generalmente el más caro por conversación de las tres opciones |

## Decisión propuesta
Evaluar primero **360dialog** por alineación con el requisito de "bajo costo" y por dejar la lógica de negocio (agente, tools, reglas) enteramente en nuestra plataforma en vez de depender de las capacidades propias del BSP. Se debe confirmar con cotización real en pesos colombianos para el volumen de ForMotos (~100 conversaciones/semana) antes de comprometerse.

## Consecuencias
- La plataforma solo necesita implementar: webhook receiver + cliente HTTP hacia el BSP elegido — no lógica de conexión directa con Meta.
- Cambiar de BSP en el futuro implica reemplazar una integración acotada (webhook + cliente API), no rediseñar el sistema, siempre que el contrato interno (`Webhook Receiver` → `Cola`) se mantenga estable.
- Pendiente de re-evaluar esta decisión con cotizaciones reales antes de iniciar la Fase 3.
