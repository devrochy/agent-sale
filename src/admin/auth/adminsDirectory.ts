import { withTransaction } from "../../shared/db/withTransaction.js";
import { deleteAdminSessionsForAdmin } from "./adminSessionDirectory.js";

export type AdminRole = "master" | "colaborador";

export function isAdminRole(value: unknown): value is AdminRole {
  return value === "master" || value === "colaborador";
}

export interface AdminPermissions {
  recibeReporteDiario: boolean;
  recibeTickets: boolean;
  recibeNotificacionPagos: boolean;
}

export interface AdminRecord {
  id: string;
  username: string;
  email: string;
  /** Número de WhatsApp para notificaciones (migrations/0034) — null si el admin no lo cargó, ese caso simplemente no recibe WhatsApp (mismo criterio que settings.report_recipient_phone). */
  phone: string | null;
  /** Data URL base64 (migrations/0037) — null si no cargó avatar, en cuyo caso el panel muestra iniciales. */
  avatarData: string | null;
  role: AdminRole;
  active: boolean;
  createdAt: Date;
  /** Ya resueltos (ver resolveEffectivePermissions) — un 'master' siempre ve todo en true, sin importar lo que diga la fila de admin_permissions. */
  permissions: AdminPermissions;
}

interface AdminRow {
  id: string;
  username: string;
  email: string;
  phone: string | null;
  avatar_data: string | null;
  password_hash: string;
  role: AdminRole;
  active: boolean;
  created_at: Date;
  recibe_reporte_diario: boolean;
  recibe_tickets: boolean;
  recibe_notificacion_pagos: boolean;
}

const ADMIN_JOIN_COLUMNS = `
  a.id, a.username, a.email, a.phone, a.avatar_data, a.password_hash, a.role, a.active, a.created_at,
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
    username: row.username,
    email: row.email,
    phone: row.phone,
    avatarData: row.avatar_data,
    role: row.role,
    active: row.active,
    createdAt: row.created_at,
    permissions: resolveEffectivePermissions(row.role, row),
  };
}

/** Login combinado (Fase 13 v2, ver ADR-032): `identifier` matchea username O correo, no hay selector ni dos formularios. */
export async function findAdminByUsernameOrEmail(
  identifier: string,
): Promise<(AdminRecord & { passwordHash: string }) | null> {
  return withTransaction(async (client) => {
    const result = await client.query<AdminRow>(
      `SELECT ${ADMIN_JOIN_COLUMNS} ${ADMIN_JOIN_FROM} WHERE a.username = $1 OR a.email = $1`,
      [identifier],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return { ...mapAdminRow(row), passwordHash: row.password_hash };
  });
}

/**
 * Chequeo de disponibilidad en vivo (Fase 13 v2, ver /admin/username-disponible
 * en server.ts) — usado al salir del campo username tanto en el alta de un
 * colaborador como en la edición del propio Perfil. `excludeAdminId` solo se
 * pasa (no-null) desde el form de Perfil: excluye al propio admin logueado
 * de la búsqueda para que su username ACTUAL no se reporte como "en uso".
 * Desde el alta de un colaborador se pasa `null` — ahí no hay que excluir a
 * nadie, si el master (por accidente o autocompletado del navegador) escribe
 * su propio username tiene que verse como ocupado igual que cualquier otro.
 */
export async function isUsernameTaken(username: string, excludeAdminId: string | null): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = excludeAdminId
      ? await client.query(`SELECT 1 FROM admins WHERE username = $1 AND id != $2`, [username, excludeAdminId])
      : await client.query(`SELECT 1 FROM admins WHERE username = $1`, [username]);
    return (result.rowCount ?? 0) > 0;
  });
}

export async function getAdminById(adminId: string): Promise<AdminRecord | null> {
  return withTransaction(async (client) => {
    const result = await client.query<AdminRow>(
      `SELECT ${ADMIN_JOIN_COLUMNS} ${ADMIN_JOIN_FROM} WHERE a.id = $1`,
      [adminId],
    );
    const row = result.rows[0];
    return row ? mapAdminRow(row) : null;
  });
}

export async function listAdmins(): Promise<AdminRecord[]> {
  return withTransaction(async (client) => {
    const result = await client.query<AdminRow>(
      `SELECT ${ADMIN_JOIN_COLUMNS} ${ADMIN_JOIN_FROM} ORDER BY a.created_at`,
    );
    return result.rows.map(mapAdminRow);
  });
}

/** Para notificaciones (Fase 13, ver dailyReport.ts / notificación de pago de ADR-024): admins activos con el permiso efectivo marcado. */
export async function listActiveAdminsWithPermission(
  permission: keyof AdminPermissions,
): Promise<AdminRecord[]> {
  const admins = await listAdmins();
  return admins.filter((admin) => admin.active && admin.permissions[permission]);
}

/**
 * A quién mandarle una notificación por WhatsApp para un permiso dado:
 * admins activos con ese permiso Y teléfono cargado (uno puede tener el
 * permiso marcado pero no haber cargado su número — ese no recibe nada).
 * Si la lista queda vacía, cae al teléfono legado (`report_recipient_phone`,
 * ver ADR-025: "puede mantenerse como fallback si ningún administrador
 * tiene el permiso marcado"). No es un "además de" — es "solo si nadie
 * más lo recibiría", para no duplicar el envío una vez que ya hay
 * colaboradores configurados.
 */
export async function resolveNotificationRecipients(
  permission: keyof AdminPermissions,
  fallbackPhone: string | null,
): Promise<string[]> {
  const admins = await listActiveAdminsWithPermission(permission);
  const phones = [...new Set(admins.map((admin) => admin.phone).filter((p): p is string => Boolean(p)))];
  if (phones.length > 0) {
    return phones;
  }
  return fallbackPhone ? [fallbackPhone] : [];
}

/** Crea el admin y su fila 1:1 de permisos (todos en false por default) en la misma transacción — ver migrations/0033_admins.cjs. `phone` opcional (migrations/0034_admins_phone.cjs) — sin él, este admin no recibe notificaciones por WhatsApp aunque tenga el permiso marcado. `username` obligatorio y único (migrations/0037) — junto con `email` y `phone` (si se carga), es lo que habilita el login combinado (ver findAdminByUsernameOrEmail). */
export async function createAdmin(
  username: string,
  email: string,
  passwordHash: string,
  role: AdminRole,
  phone: string | null,
): Promise<string> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO admins (username, email, password_hash, role, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [username, email, passwordHash, role, phone],
    );
    const adminId = result.rows[0]!.id;
    await client.query(`INSERT INTO admin_permissions (admin_id) VALUES ($1)`, [adminId]);
    return adminId;
  });
}

/**
 * Auto-edición de perfil (Fase 13 v2, ver ADR-032): cualquier admin —
 * master o colaborador por igual — puede editar sus propios username,
 * correo, teléfono y avatar desde `/admin/perfil`. Reemplaza los 4 campos
 * completos (mismo criterio "sin merge" que `saveBehaviorConfig`) — no
 * toca `role`/`active`/permisos, esos siguen siendo exclusivos del master
 * vía `setAdminActive`/`updateAdminPermissions`.
 */
export async function updateAdminProfile(
  adminId: string,
  profile: { username: string; email: string; phone: string | null; avatarData: string | null },
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE admins SET username = $1, email = $2, phone = $3, avatar_data = $4 WHERE id = $5`,
      [profile.username, profile.email, profile.phone, profile.avatarData, adminId],
    );
  });
}

/**
 * Reescribe la contraseña y cierra todas las sesiones abiertas del admin,
 * en la misma transacción (ver `deleteAdminSessionsForAdmin`). Los dos
 * caminos que llegan acá —"Cambiar contraseña" desde el Perfil y el enlace
 * de recuperación— comparten esa consecuencia: después de cambiarla hay que
 * volver a entrar en todos lados, incluido el navegador desde el que se
 * hizo el cambio.
 *
 * No valida nada: quién puede cambiarle la contraseña a quién, y qué
 * cuenta por contraseña aceptable, se decide antes de llamar (ver
 * `cambiarContrasenaPropia` y `restablecerContrasenaConToken` en
 * adminPanel.ts), mismo criterio que `updateAdminProfile`.
 */
export async function updateAdminPassword(adminId: string, passwordHash: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`UPDATE admins SET password_hash = $1 WHERE id = $2`, [
      passwordHash,
      adminId,
    ]);
    await deleteAdminSessionsForAdmin(client, adminId);
  });
}

/**
 * Cambia el rol desde Colaboradores. Va aparte de `updateAdminProfile`
 * porque no es un dato de contacto sino el nivel de acceso: cambiarlo es lo
 * único de esta pantalla que puede dejar a alguien adentro o afuera de la
 * gestión de cuentas, y quién puede hacerlo se decide antes de llamar (ver
 * `editarColaborador`).
 *
 * No toca `admin_permissions`: un master los tiene todos por definición
 * (ver `resolveEffectivePermissions`), así que su fila queda como estaba y
 * vuelve a tener efecto tal cual si algún día baja a colaborador.
 */
export async function updateAdminRole(adminId: string, role: AdminRole): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`UPDATE admins SET role = $1 WHERE id = $2`, [role, adminId]);
  });
}

export async function setAdminActive(adminId: string, active: boolean): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`UPDATE admins SET active = $1 WHERE id = $2`, [active, adminId]);
  });
}

/** No tiene efecto visible si el admin es 'master' (ver resolveEffectivePermissions) — se permite igual para no bifurcar la UI de Colaboradores. */
export async function updateAdminPermissions(
  adminId: string,
  permissions: AdminPermissions,
): Promise<void> {
  await withTransaction(async (client) => {
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
