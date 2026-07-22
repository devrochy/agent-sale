# advisor

Vista mínima de solo lectura para el asesor humano que recibe una conversación escalada (ver `docs/fase-7-escalamiento-humano/vista-asesor.md`). No es una app nueva ni un chat embebido — el asesor sigue respondiendo por WhatsApp; esta vista solo da contexto y dos acciones (tomar / marcar resuelto).

- `handoffView.ts` — `renderHandoffView(token)` arma la página (datos del cliente, motivo + resumen, historial completo con las tools ejecutadas, estado estructurado); `tomarConversacion(token)` y `resolverConversacion(token)` mueven `handoff_queue.status` (`queued` → `en_atencion` → `resuelto`).

Acceso por enlace único (`handoff_tokens`, ver `migrations/0015_handoff_tokens.cjs` y `src/shared/db/handoffTokenDirectory.ts`) generado por `domains/escalation/escalarHumano.ts` al escalar — no hay sistema de login, consistente con un equipo pequeño (ver vista-asesor.md, "autenticación de la vista"). Las rutas HTTP (`GET /asesor/:token`, `POST /asesor/:token/tomar`, `POST /asesor/:token/resolver`) se registran en `gateway/server.ts` (un solo Fastify por proceso, ver ADR de monolito de la Fase 2).
