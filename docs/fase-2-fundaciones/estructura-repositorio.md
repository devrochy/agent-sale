# Estructura de repositorio propuesta

Documento de diseño — **no crea todavía las carpetas/archivos reales**, eso ocurre al iniciar la implementación de código (fuera del alcance de este plan de fases, que es solo de arquitectura).

## Principio

Monolito modular: un único servicio desplegable, organizado internamente por dominio siguiendo los módulos ya definidos en la [arquitectura de la Fase 1](../fase-1-arquitectura/arquitectura.md). Cada carpeta de dominio es autocontenida (su propia lógica, sus propios tipos/schemas) y solo se comunica con otras a través de interfaces explícitas — así, extraer un dominio a un servicio separado en el futuro (si la carga lo exige) no requiere reescribir su lógica interna.

## Árbol propuesto

```
agent-sale/
├── docs/                          # Documentación de arquitectura y fases (ya existente)
├── src/
│   ├── gateway/                   # Webhook receiver, verificación de firma, cliente BSP (Twilio)
│   ├── orchestrator/              # Orquestador del agente: arma contexto, llama a Claude, ejecuta tools
│   ├── domains/
│   │   ├── catalog/                # Catálogo/Inventario (consultar_inventario, sync con Sheets)
│   │   ├── commerce/               # Cotizaciones, pedidos, promociones, recomendaciones
│   │   └── escalation/             # Máquina de estados de escalamiento, handoff_queue
│   ├── shared/
│   │   ├── db/                     # Cliente Postgres, políticas RLS, migraciones
│   │   ├── audit/                  # Logging de auditoría de decisiones del agente
│   │   └── observability/          # Métricas, tracing
│   └── config/                     # Carga de configuración/secretos por entorno
├── tests/
│   ├── unit/                       # Por dominio, espejo de src/domains
│   ├── integration/                # Flujos completos (mensaje → tool → respuesta)
│   └── evals/                      # Golden set de conversaciones (Fase 9)
├── .github/workflows/              # Pipeline CI/CD (ver pipeline-ci-cd.md)
├── Dockerfile
├── fly.toml                        # Configuración de despliegue (ADR-005)
├── .env.example
└── README.md
```

## Reglas de dependencia entre módulos

- `domains/*` no se importan entre sí directamente — solo a través del `orchestrator`, que es el único que conoce el flujo completo de una conversación.
- `gateway` no conoce nada de dominios de negocio — solo recibe/envía mensajes y los pasa a `orchestrator` vía la cola.
- `shared/db` es el único punto de acceso a Postgres — ningún dominio abre su propia conexión, para poder garantizar que el `tenant_id` de sesión (RLS) se setea siempre de la misma forma (ver [multi-tenant-rls.md](./multi-tenant-rls.md)).

## Qué no está resuelto todavía

- Lenguaje/framework específico — se decide al iniciar la implementación real de código, fuera de este plan de arquitectura.
- Estructura interna de cada carpeta de dominio (controladores, servicios, repositorios) — detalle de implementación, no de arquitectura.
