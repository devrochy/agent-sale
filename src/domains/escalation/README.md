# domains/escalation

`escalarHumano.ts` implementa la tool `escalar_a_humano` (insert en `handoff_queue`) desde el incremento de Fase 4. La máquina de estados de reglas explícitas de *cuándo* escalar vive en el `orchestrator` (`loop.ts`); la asignación a un asesor específico y la bandeja de trabajo llegan con el incremento de Fase 7 (ver `docs/fase-7-escalamiento-humano/`).

No se importa directamente desde otros `domains/*` — solo a través de `orchestrator`.
