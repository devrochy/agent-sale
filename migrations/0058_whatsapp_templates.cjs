// Plantillas de Meta Message Templates gestionadas desde el panel (ver
// docs/fase-3-whatsapp-gateway/plantillas-mensajes.md — diseñado en la Fase
// 3, nunca implementado hasta ahora).
//
// No hay plantilla "solo local, nunca enviada a Meta": crear una desde el
// panel implica mandarla a revisión (POST .../message_templates) en el
// mismo paso, así que la fila nace reflejando lo que Meta ya sabe. `status`
// arranca en 'pending' porque eso es lo que Meta devuelve casi siempre al
// crear; se actualiza con "Sincronizar" (consulta manual) o al reenviarla.
//
// `hello_world` — la plantilla de ejemplo que trae cualquier WABA, ya
// aprobada, sin variables — no vive en esta tabla: el panel la trata como
// una fila sintética para poder probar el envío sin esperar aprobación.
//
// `components` va como jsonb y no columnas separadas: es exactamente la
// forma que exige la Graph API (HEADER/BODY/FOOTER/BUTTONS, cada uno con
// campos distintos) y se reenvía tal cual al crear y al armar el envío de
// prueba — normalizarlo en columnas obligaría a reconstruirlo antes de cada
// llamada a Meta sin ninguna ganancia de consulta (nadie filtra por el
// contenido de un componente).
//
// `connection_id` referencia la conexión de WhatsApp/Meta cuyo WABA ID y
// access token se usan para crear/consultar/enviar la plantilla — no un
// "WABA suelto", para no duplicar credenciales que ya vive cifradas en
// `channel_connections` (Fase 19).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE whatsapp_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      connection_id uuid NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
      name text NOT NULL,
      category text NOT NULL CHECK (category IN ('UTILITY', 'MARKETING', 'AUTHENTICATION')),
      language text NOT NULL,
      components jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_review', 'approved', 'rejected', 'paused', 'disabled')),
      external_template_id text,
      rejection_reason text,
      created_by_admin_id uuid REFERENCES admins(id),
      last_synced_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (connection_id, name, language)
    );

    CREATE INDEX whatsapp_templates_connection_id_idx ON whatsapp_templates (connection_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE whatsapp_templates;
  `);
};
