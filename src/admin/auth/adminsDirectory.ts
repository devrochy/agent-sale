import { withTenant } from "../../shared/db/withTenant.js";

export type AdminRole = "master" | "colaborador";

export interface AdminPermissions {
  recibeReporteDiario: boolean;
  recibeTickets: boolean;
  recibeNotificacionPagos: boolean;
}

export interface AdminRecord {
  id: string;
  email: string;
  role: AdminRole;
  active: boolean;
  createdAt: Date;
  /** Ya resueltos (ver resolveEffectivePermissions) — un 'master' siempre ve todo en true, sin importar lo que diga la fila de admin_permissions. */
  permissions: AdminPermissions;
}

interface AdminRow {
  id: string;
  email: string;
  password_hash: string;
  role: AdminRole;
  active: boolean;
  created_at: Date;
  recibe_reporte_diario: boolean;
  recibe_tickets: boolean;
  recibe_notificacion_pagos: boolean;
}

const ADMIN_JOIN_COLUMNS = `
  a.id, a.email, a.password_hash, a.role, a.active, a.created_at,
  p.recibe_reporte_diario, p.recibe_tickets, p.recibe_notificacion_pagos
`;
const ADMIN_JOIN_FROM = `FROM admins a JOIN admin_permissions p ON p.admin_id = a.id`;

/** Un admin con role='master' tiene todos los permisos implícitos (ver ADR-025) — la fila de admin_permissions no manda para ese caso. */
function resolveEffectivePermissions(role: AdminRole, row: AdminRow): AdminPermissions {
  if (role === "master") {
    return { recibeReporteDiario: true, recibeTickets: true, recibeNotificacionPagos: true };
  }
  return {
    recibeReporteDiario: row.recibe_reporte_diario,
    recibeTickets: row.recibe_tickets,
    recibeNotificacionPagos: row.recibe_notificacion_pagos,
  };
}

function mapAdminRow(row: AdminRow): AdminRecord {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    active: row.active,
    createdAt: row.created_at,
    permissions: resolveEffectivePermissions(row.role, row),
  };
}

export async function findAdminByEmail(
  tenantId: string,
  email: string,
): Promise<(AdminRecord & { passwordHash: string }) | null> {
  return withTenant(tenantId, async (client) => {
    const result = await client.query<AdminRow>(
      `SELECT ${ADMIN_JOIN_COLUMNS} ${ADMIN_JOIN_FROM} WHERE a.email = $1`,
      [email],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return { ...mapAdminRow(row), passwordHash: row.password_hash };
  });
}

export async function getAdminById(tenantId: string, adminId: string): Promise<AdminRecord | null> {
  return withTenant(tenantId, async (client) => {
    const result = await client.query<AdminRow>(
      `SELECT ${ADMIN_JOIN_COLUMNS} ${ADMIN_JOIN_FROM} WHERE a.id = $1`,
      [adminId],
    );
    const row = result.rows[0];
    return row ? mapAdminRow(row) : null;
  });
}

export async function listAdmins(tenantId: string): Promise<AdminRecord[]> {
  return withTenant(tenantId, async (client) => {
    const result = await client.query<AdminRow>(
      `SELECT ${ADMIN_JOIN_COLUMNS} ${ADMIN_JOIN_FROM} ORDER BY a.created_at`,
    );
    return result.rows.map(mapAdminRow);
  });
}

/** Para notificaciones (Fase 13, ver dailyReport.ts / notificación de pago de ADR-024): admins activos con el permiso efectivo marcado. */
export async function listActiveAdminsWithPermission(
  tenantId: string,
  permission: keyof AdminPermissions,
): Promise<AdminRecord[]> {
  const admins = await listAdmins(tenantId);
  return admins.filter((admin) => admin.active && admin.permissions[permission]);
}

/** Crea el admin y su fila 1:1 de permisos (todos en false por default) en la misma transacción — ver migrations/0033_admins.cjs. */
export async function createAdmin(
  tenantId: string,
  email: string,
  passwordHash: string,
  role: AdminRole,
): Promise<string> {
  return withTenant(tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO admins (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, email, passwordHash, role],
    );
    const adminId = result.rows[0]!.id;
    await client.query(`INSERT INTO admin_permissions (admin_id, tenant_id) VALUES ($1, $2)`, [
      adminId,
      tenantId,
    ]);
    return adminId;
  });
}

export async function setAdminActive(
  tenantId: string,
  adminId: string,
  active: boolean,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(`UPDATE admins SET active = $1 WHERE id = $2`, [active, adminId]);
  });
}

/** No tiene efecto visible si el admin es 'master' (ver resolveEffectivePermissions) — se permite igual para no bifurcar la UI de Colaboradores. */
export async function updateAdminPermissions(
  tenantId: string,
  adminId: string,
  permissions: AdminPermissions,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `UPDATE admin_permissions
       SET recibe_reporte_diario = $1, recibe_tickets = $2, recibe_notificacion_pagos = $3
       WHERE admin_id = $4`,
      [
        permissions.recibeReporteDiario,
        permissions.recibeTickets,
        permissions.recibeNotificacionPagos,
        adminId,
      ],
    );
  });
}
