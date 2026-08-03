// Fase 13 (v2, ver docs/fase-13-identidad-roles-notificaciones/adrs/
// ADR-025-autenticacion-real-y-permisos-colaboradores.md): reemplaza el
// Basic Auth global (ADR-015) por administradores individuales con sesión
// y permisos granulares.
//
// `admins`/`admin_permissions` son dato de negocio por tenant → RLS
// explícito, mismo patrón que `reviews`/`llm_usage` (migrations 0028/0023):
// 0010_rls_policies.cjs solo corrió una vez, contra las tablas que existían
// en ese momento.
//
// `admin_permissions` es 1:1 con `admins` (admin_id como PK). `tenant_id`
// se denormaliza acá (mismo criterio que `quote_items.tenant_id`, ver
// migrations/0007) porque la policy de RLS necesita la columna en la
// propia tabla, no vía join. Regla de aplicación (no de esquema, ver
// ADR-025): un admin con role='master' tiene todos los permisos
// implícitos sin importar lo que diga esta tabla — la fila igual se crea
// para simplificar el código (siempre hay una fila 1:1 con `admins`).
//
// `admin_sessions` es, en cambio, el paso de resolución previo a tener
// `app.tenant_id` en sesión (la cookie solo trae el token) — mismo
// criterio exacto que `handoff_tokens`/`review_tokens` (migrations
// 0015/0029): tabla deliberadamente SIN RLS. `token` se genera con
// randomBytes(24).toString("base64url"), igual que esos dos.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE admins (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      email text NOT NULL,
      password_hash text NOT NULL,
      role text NOT NULL DEFAULT 'colaborador' CHECK (role IN ('master', 'colaborador')),
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, email)
    );
    CREATE INDEX admins_tenant_id_idx ON admins(tenant_id);

    ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
    ALTER TABLE admins FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON admins
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

    CREATE TABLE admin_permissions (
      admin_id uuid PRIMARY KEY REFERENCES admins(id),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      recibe_reporte_diario boolean NOT NULL DEFAULT false,
      recibe_tickets boolean NOT NULL DEFAULT false,
      recibe_notificacion_pagos boolean NOT NULL DEFAULT false
    );
    CREATE INDEX admin_permissions_tenant_id_idx ON admin_permissions(tenant_id);

    ALTER TABLE admin_permissions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE admin_permissions FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON admin_permissions
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

    CREATE TABLE admin_sessions (
      token text PRIMARY KEY,
      admin_id uuid NOT NULL REFERENCES admins(id),
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX admin_sessions_admin_id_idx ON admin_sessions(admin_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS admin_sessions;
    DROP POLICY IF EXISTS tenant_isolation ON admin_permissions;
    DROP TABLE IF EXISTS admin_permissions;
    DROP POLICY IF EXISTS tenant_isolation ON admins;
    DROP TABLE IF EXISTS admins;
  `);
};
