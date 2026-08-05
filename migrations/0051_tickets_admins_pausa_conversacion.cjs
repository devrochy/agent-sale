// Fase 18 (ver docs/fase-18-tickets-conversaciones-panel/README.md y
// adrs/ADR-028-convivencia-flujo-token-vs-panel.md, Opción 3): mueve la
// asignación de tickets escalados de `human_agents` (sistema legado,
// previo al login real de Fase 13) a `admins`, y agrega un kill-switch de
// bot por conversación puntual — tercer nivel junto a `settings.bot_paused`
// (migrations/0020) y `customers.bot_paused` (migrations/0050).
//
// El enlace de WhatsApp (`GET /asesor/:token`) pasa a ser de solo lectura
// (ADR-028): ya no hay "asesor dueño del token" que pueda tomar/resolver
// desde ahí, así que `handoff_tokens.human_agent_id` deja de tener sentido.
// `human_agents` queda sin más consumidores tras este cambio (ver
// escalarHumano.ts, que pasa a notificar vía `admin_permissions.recibe_tickets`)
// y se retira.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE conversations ADD COLUMN bot_paused boolean NOT NULL DEFAULT false;

    ALTER TABLE handoff_queue ADD COLUMN assigned_admin_id uuid REFERENCES admins(id);
    ALTER TABLE handoff_queue DROP COLUMN assigned_to;

    ALTER TABLE handoff_tokens DROP COLUMN human_agent_id;

    DROP TABLE human_agents;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE TABLE human_agents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      contact text NOT NULL,
      active boolean NOT NULL DEFAULT true
    );

    ALTER TABLE handoff_tokens ADD COLUMN human_agent_id uuid REFERENCES human_agents(id);

    ALTER TABLE handoff_queue ADD COLUMN assigned_to uuid REFERENCES human_agents(id);
    ALTER TABLE handoff_queue DROP COLUMN assigned_admin_id;

    ALTER TABLE conversations DROP COLUMN bot_paused;
  `);
};
